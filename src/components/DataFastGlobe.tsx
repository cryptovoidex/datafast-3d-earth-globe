"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as topojson from "topojson-client";
import { geoEquirectangular, geoPath } from "d3-geo";
import { GEO_LABELS, GeoPlaceLabel } from "@/data/geo-labels";

export type GlobeViewMode = "full" | "horizon";

export interface DataFastGlobeProps {
  /** Initial latitude of the globe center (default: 15 - Europe/Africa/Atlantic view like DataFast screenshot) */
  initialLat?: number;
  /** Initial longitude of the globe center (default: -8 - Europe/Africa/Atlantic view) */
  initialLng?: number;
  /** Initial view mode: 'full' (centered 3D globe) or 'horizon' (tilted bottom-anchored horizon arc) */
  defaultViewMode?: GlobeViewMode;
  /** Show the top-right view mode switcher button (default: true) */
  showViewToggle?: boolean;
  /** Enable gentle auto-rotation when idle (default: false) */
  autoRotate?: boolean;
  /** Auto-rotation speed (default: 0.35) */
  autoRotateSpeed?: number;
  /** Optional CSS class for the outer container */
  className?: string;
}

/**
 * Converts (lat, lng) in degrees to a 3D Cartesian vector on a sphere of radius R.
 * Matches Three.js SphereGeometry UV mapping where:
 * u = 0.5 + lng / 360, v = 0.5 + lat / 180
 */
function latLngToVector3(lat: number, lng: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);

  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const y = radius * Math.cos(phi);
  const z = radius * Math.sin(phi) * Math.sin(theta);

  return new THREE.Vector3(x, y, z);
}

/**
 * Creates a soft circular sprite texture for stars so they have a realistic pinpoint glow.
 */
function createStarTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.25, "rgba(225, 238, 255, 0.85)");
  gradient.addColorStop(0.6, "rgba(150, 190, 255, 0.25)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export default function DataFastGlobe({
  initialLat = 15,
  initialLng = -8,
  defaultViewMode = "full",
  showViewToggle = true,
  autoRotate = false,
  autoRotateSpeed = 0.35,
  className = "",
}: DataFastGlobeProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelsContainerRef = useRef<HTMLDivElement | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<GlobeViewMode>(defaultViewMode);
  const viewModeRef = useRef<GlobeViewMode>(defaultViewMode);

  // Trigger smooth camera & globe transition when viewMode changes
  const toggleViewMode = (nextMode?: GlobeViewMode) => {
    const target = nextMode ?? (viewMode === "full" ? "horizon" : "full");
    viewModeRef.current = target;
    setViewMode(target);
  };

  useEffect(() => {
    const container = mountRef.current;
    const labelsContainer = labelsContainerRef.current;
    if (!container || !labelsContainer) return;

    let isDisposed = false;
    let animationFrameId: number;

    // 1. SCENE, CAMERA & RENDERER
    const scene = new THREE.Scene();

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 1000);
    const EARTH_RADIUS = 10;

    // Full View vs Horizon View camera & screen framing parameters
    // Using PerspectiveCamera.setViewOffset shifts the optical center of the lens downward in Horizon mode!
    // This keeps the globe's 3D rotation 100% natural around its center while placing the top curved
    // horizon arc at ~33% from the top of the screen and zooming in wide so the bottom fills 90% of the screen width!
    const FULL_DISTANCE = 22.8;
    const HORIZON_DISTANCE = 19.6; // Wide dome that leaves starry space above the top horizon arc
    const FULL_VIEW_OFFSET_Y_FACTOR = 0.0;
    const HORIZON_VIEW_OFFSET_Y_FACTOR = -0.62; // Shifts the camera window UP so the Earth sits in the BOTTOM half of the screen!

    const isInitialHorizon = viewModeRef.current === "horizon";
    const startLat = isInitialHorizon ? 36 : initialLat;
    const startLng = isInitialHorizon ? -88 : initialLng;
    const startDist = isInitialHorizon ? HORIZON_DISTANCE : FULL_DISTANCE;
    let currentOffsetYFactor = isInitialHorizon
      ? HORIZON_VIEW_OFFSET_Y_FACTOR
      : FULL_VIEW_OFFSET_Y_FACTOR;
    let targetOffsetYFactor = currentOffsetYFactor;
    let lastAppliedMode: GlobeViewMode = viewModeRef.current;

    // Camera transition state (smooth spherical slerp + optical lens shift when switching modes)
    let isTransitioningCamera = false;
    let transitionProgress = 1;
    const transitionStartOffset = new THREE.Vector3();
    const transitionEndOffset = new THREE.Vector3();

    const applyCameraViewOffset = (w: number, h: number, yFactor: number) => {
      if (Math.abs(yFactor) < 0.0005) {
        camera.clearViewOffset();
      } else {
        camera.setViewOffset(w, h, 0, yFactor * h, w, h);
      }
      camera.updateProjectionMatrix();
    };

    const initialCamPos = latLngToVector3(startLat, startLng, startDist);
    camera.position.copy(initialCamPos);
    camera.lookAt(0, 0, 0);
    applyCameraViewOffset(width, height, currentOffsetYFactor);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.NoToneMapping;

    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // 2. ORBIT CONTROLS
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.rotateSpeed = 0.52;
    controls.zoomSpeed = 0.75;
    controls.minDistance = 12.6;
    controls.maxDistance = 40;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = autoRotateSpeed;

    // 3. GLOBE GROUP
    const globeGroup = new THREE.Group();
    scene.add(globeGroup);

    // 4. LAYER 1: DEEP SPACE STARFIELD (2 Layers: crisp pinpoint stars + brighter blue/white stars)
    const starTexture = createStarTexture();
    const createStarLayer = (count: number, size: number, opacity: number, colorHex: string) => {
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const baseColor = new THREE.Color(colorHex);

      for (let i = 0; i < count; i++) {
        const r = 85 + Math.random() * 140;
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);

        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);

        const brightness = 0.5 + Math.random() * 0.5;
        colors[i * 3] = baseColor.r * brightness;
        colors[i * 3 + 1] = baseColor.g * brightness;
        colors[i * 3 + 2] = baseColor.b * brightness;
      }

      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

      const mat = new THREE.PointsMaterial({
        size,
        map: starTexture,
        vertexColors: true,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      return new THREE.Points(geo, mat);
    };

    const smallStars = createStarLayer(2800, 0.7, 0.85, "#dbe8ff");
    const brightStars = createStarLayer(450, 1.35, 0.95, "#ffffff");
    scene.add(smallStars);
    scene.add(brightStars);

    // 5. LAYER 2: THICK, SOFT DIFFUSED ATMOSPHERE HALO (Perspective-corrected Billboard behind the Earth)
    const HALO_PLANE_SIZE = EARTH_RADIUS * 5.6;
    const haloGeo = new THREE.PlaneGeometry(HALO_PLANE_SIZE, HALO_PLANE_SIZE);
    const haloMat = new THREE.ShaderMaterial({
      uniforms: {
        uVisualRadius: { value: EARTH_RADIUS },
      },
      vertexShader: `
        varying vec2 vLocalPos;
        void main() {
          vLocalPos = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uVisualRadius;
        varying vec2 vLocalPos;

        void main() {
          // Normalized distance from apparent horizon edge of Earth (1.0 = exact visible limb at any zoom distance!)
          float r = length(vLocalPos) / uVisualRadius;

          // Distance outside the Earth's visible limb
          float distFromLimb = max(0.0, r - 0.985);

          // 1) Bright, concentrated royal-blue inner horizon glow right along the Earth's edge
          float innerRim = exp(-distFromLimb * 4.8) * 0.78;

          // 2) Wide, thick, soft sapphire-blue outer atmospheric scatter into deep space
          float outerScatter = exp(-distFromLimb * 1.45) * 0.56;

          // Smoothly ensure zero clipping at the far edges of the plane
          float edgeFade = 1.0 - smoothstep(1.85, 2.55, r);

          float totalAlpha = (innerRim + outerScatter) * edgeFade;

          // Color gradient: vibrant royal blue right at the horizon -> deep space navy further out
          vec3 innerBlue = vec3(0.18, 0.42, 0.88);
          vec3 midBlue   = vec3(0.09, 0.23, 0.56);
          vec3 deepBlue  = vec3(0.03, 0.08, 0.22);

          float t = clamp(distFromLimb / 0.85, 0.0, 1.0);
          vec3 col = mix(innerBlue, midBlue, smoothstep(0.0, 0.45, t));
          col = mix(col, deepBlue, smoothstep(0.35, 1.0, t));

          gl_FragColor = vec4(col, clamp(totalAlpha, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    const atmosphereBillboard = new THREE.Mesh(haloGeo, haloMat);
    scene.add(atmosphereBillboard);

    // 6. LAYER 3: DARK MATTE EARTH SPHERE WITH EXACT DATAFAST COLORS
    const placeholderCanvas = document.createElement("canvas");
    placeholderCanvas.width = 64;
    placeholderCanvas.height = 32;
    const pCtx = placeholderCanvas.getContext("2d")!;
    pCtx.fillStyle = "#141720";
    pCtx.fillRect(0, 0, 64, 32);
    const initialEarthTex = new THREE.CanvasTexture(placeholderCanvas);

    const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 128, 128);
    const earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: initialEarthTex },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vViewNormal;
        varying vec3 vViewDir;

        void main() {
          vUv = uv;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vViewNormal = normalize(normalMatrix * normal);
          vViewDir = normalize(-mvPosition.xyz);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec2 vUv;
        varying vec3 vViewNormal;
        varying vec3 vViewDir;

        void main() {
          vec4 texColor = texture2D(uMap, vUv);

          // Facing ratio: 1.0 at center facing camera, 0.0 at horizon edge
          float facing = max(0.0, dot(vViewNormal, vViewDir));

          // Keep countries (#282b33) and borders (#4a4e58) clearly visible across the whole globe
          float shade = mix(0.76, 1.06, pow(facing, 0.45));
          vec3 baseColor = texColor.rgb * shade;

          // Soft atmospheric blue inner rim on the globe's horizon
          float rim = pow(1.0 - facing, 3.2);
          vec3 rimColor = vec3(0.15, 0.36, 0.82) * rim * 0.42;

          gl_FragColor = vec4(baseColor + rimColor, 1.0);
        }
      `,
    });

    const earthMesh = new THREE.Mesh(earthGeo, earthMat);
    globeGroup.add(earthMesh);

    // 7. LOAD TOPOJSON & RENDER HIGH-RES EQUIRRECTANGULAR MAP
    fetch("/countries-50m.json")
      .then((res) => res.json())
      .then((topology) => {
        if (isDisposed) return;

        const countriesGeo = topojson.feature(
          topology,
          topology.objects.countries
        ) as unknown as GeoJSON.FeatureCollection;

        const mapCanvas = document.createElement("canvas");
        const W = 8192;
        const H = 4096;
        mapCanvas.width = W;
        mapCanvas.height = H;
        const ctx = mapCanvas.getContext("2d")!;

        // 1) Deep dark navy-slate ocean background (#13161f)
        ctx.fillStyle = "#13161f";
        ctx.fillRect(0, 0, W, H);

        const projection = geoEquirectangular()
          .translate([W / 2, H / 2])
          .scale(W / (2 * Math.PI));

        const pathGenerator = geoPath(projection, ctx);

        // 2) Distinct dark charcoal-grey landmass fill (#282b33)
        ctx.beginPath();
        pathGenerator(countriesGeo);
        ctx.fillStyle = "#282b33";
        ctx.fill();

        // 3) Crisp country borders (#494e59)
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = "#494e59";
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();

        const highResTexture = new THREE.CanvasTexture(mapCanvas);
        highResTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        highResTexture.minFilter = THREE.LinearMipmapLinearFilter;
        highResTexture.magFilter = THREE.LinearFilter;
        highResTexture.needsUpdate = true;

        earthMat.uniforms.uMap.value = highResTexture;
        initialEarthTex.dispose();
        setIsLoaded(true);
      })
      .catch((err) => {
        console.error("Failed to load world countries TopoJSON:", err);
      });

    // 8. LAYER 4: BILLBOARD GEOGRAPHICAL LABELS WITH COLLISION AVOIDANCE
    labelsContainer.innerHTML = "";
    interface LabelEntry {
      data: GeoPlaceLabel;
      el: HTMLDivElement;
      localPos: THREE.Vector3;
      normal: THREE.Vector3;
      priority: number;
      approxW: number;
      approxH: number;
    }

    const labelEntries: LabelEntry[] = GEO_LABELS.map((item) => {
      const el = document.createElement("div");
      el.style.position = "absolute";
      el.style.left = "0px";
      el.style.top = "0px";
      el.style.pointerEvents = "none";
      el.style.userSelect = "none";
      el.style.whiteSpace = "pre-line";
      el.style.textAlign = "center";
      el.style.lineHeight = "1.15";
      el.style.transform = "translate3d(-9999px, -9999px, 0)";
      el.style.willChange = "transform, opacity";

      let priority = 1;
      if (item.type === "ocean") {
        priority = item.size === "lg" ? 4 : 2;
        el.style.fontFamily = "var(--font-geist-sans), Inter, system-ui, sans-serif";
        el.style.fontStyle = "italic";
        el.style.fontWeight = "500";
        el.style.letterSpacing = "0.09em";
        el.style.color = "rgba(116, 125, 142, 0.56)";
        el.style.fontSize = item.size === "lg" ? "14px" : "11px";
        el.style.textShadow = "0 1px 4px rgba(0,0,0,0.85)";
      } else if (item.type === "city") {
        priority = 2;
        el.style.fontFamily = "var(--font-geist-sans), Inter, system-ui, sans-serif";
        el.style.fontWeight = "600";
        el.style.letterSpacing = "0.01em";
        el.style.color = "rgba(220, 226, 236, 0.9)";
        el.style.fontSize = "11px";
        el.style.textShadow =
          "-1px -1px 0 #141720, 1px -1px 0 #141720, -1px 1px 0 #141720, 1px 1px 0 #141720, 0 2px 4px rgba(0,0,0,0.9)";
      } else {
        priority = item.size === "lg" ? 5 : item.size === "md" ? 3 : 1;
        el.style.fontFamily = "var(--font-geist-sans), Inter, system-ui, sans-serif";
        el.style.fontWeight = "600";
        el.style.letterSpacing = "0.015em";
        el.style.color = "rgba(148, 154, 166, 0.85)";
        el.style.fontSize =
          item.size === "lg" ? "13px" : item.size === "md" ? "11.5px" : "10.5px";
        el.style.textShadow =
          "-1px -1px 0 #1b1e26, 1px -1px 0 #1b1e26, -1px 1px 0 #1b1e26, 1px 1px 0 #1b1e26, 0 1px 3px rgba(0,0,0,0.95)";
      }

      el.textContent = item.name;
      labelsContainer.appendChild(el);

      const lines = item.name.split("\n");
      const maxChars = Math.max(...lines.map((l) => l.length));
      const approxW = maxChars * 6.5 + 10;
      const approxH = lines.length * 14 + 6;

      const localPos = latLngToVector3(item.lat, item.lng, EARTH_RADIUS * 1.003);
      const normal = localPos.clone().normalize();

      return {
        data: item,
        el,
        localPos,
        normal,
        priority,
        approxW,
        approxH,
      };
    });

    labelEntries.sort((a, b) => b.priority - a.priority);

    // Stop camera zoom/tilt transition if user manually grabs the globe
    const onUserInteractStart = () => {
      isTransitioningCamera = false;
    };
    controls.addEventListener("start", onUserInteractStart);

    // 9. ANIMATION, SMOOTH VIEW TRANSITION & COLLISION-FREE LABEL PROJECTION LOOP
    const tempProjVec = new THREE.Vector3();
    const cameraDir = new THREE.Vector3();
    const placedBoxes: { x1: number; y1: number; x2: number; y2: number }[] = [];

    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const animate = () => {
      if (isDisposed) return;
      animationFrameId = requestAnimationFrame(animate);

      const currentWidth = container.clientWidth || window.innerWidth;
      const currentHeight = container.clientHeight || window.innerHeight;

      // Detect if user toggled between 'full' and 'horizon' view mode
      if (viewModeRef.current !== lastAppliedMode) {
        lastAppliedMode = viewModeRef.current;
        const toHorizon = lastAppliedMode === "horizon";

        targetOffsetYFactor = toHorizon
          ? HORIZON_VIEW_OFFSET_Y_FACTOR
          : FULL_VIEW_OFFSET_Y_FACTOR;

        transitionStartOffset.copy(camera.position);

        // Compute target camera position:
        // In Horizon mode, zoom in close (HORIZON_DISTANCE = 14.35) so the Earth's dome fills 90% of the screen width,
        // and tilt toward the northern hemisphere (~36 deg latitude) so United States, Canada, Houston, Toronto, New York, Calgary
        // sit right along the curved top horizon crest like the DataFast screenshot!
        const currentSpherical = new THREE.Spherical().setFromVector3(transitionStartOffset);
        const targetRadius = toHorizon ? HORIZON_DISTANCE : FULL_DISTANCE;

        // Polar angle phi: 0 = North Pole, PI/2 = Equator
        // 36 deg latitude corresponds to phi = (90 - 36) * PI/180 = 0.94 rad
        const targetPhi = toHorizon
          ? Math.max(0.65, Math.min(1.02, currentSpherical.phi - 0.28))
          : Math.max(0.85, Math.min(1.36, currentSpherical.phi + 0.28));

        const targetSpherical = new THREE.Spherical(
          targetRadius,
          targetPhi,
          currentSpherical.theta
        );
        transitionEndOffset.setFromSpherical(targetSpherical);

        transitionProgress = 0;
        isTransitioningCamera = true;
      }

      // Smoothly interpolate camera spherical coordinates & lens vertical offset
      if (isTransitioningCamera) {
        transitionProgress = Math.min(1, transitionProgress + 0.02);
        const eased = easeInOutCubic(transitionProgress);

        const startSph = new THREE.Spherical().setFromVector3(transitionStartOffset);
        const endSph = new THREE.Spherical().setFromVector3(transitionEndOffset);

        const lerpedRadius = THREE.MathUtils.lerp(startSph.radius, endSph.radius, eased);
        const lerpedPhi = THREE.MathUtils.lerp(startSph.phi, endSph.phi, eased);
        const lerpedTheta = THREE.MathUtils.lerp(startSph.theta, endSph.theta, eased);

        camera.position.setFromSphericalCoords(lerpedRadius, lerpedPhi, lerpedTheta);

        if (transitionProgress >= 1) {
          isTransitioningCamera = false;
        }
      }

      // Smoothly damp the vertical view offset even if the user interacts mid-transition
      if (Math.abs(currentOffsetYFactor - targetOffsetYFactor) > 0.0004) {
        currentOffsetYFactor = THREE.MathUtils.lerp(
          currentOffsetYFactor,
          targetOffsetYFactor,
          0.085
        );
        applyCameraViewOffset(currentWidth, currentHeight, currentOffsetYFactor);
      }

      controls.update();

      // Calculate exact perspective tangent horizon radius at the billboard plane (depth = camDist)
      // For a sphere of radius R viewed from distance D, the tangent cone projects to radius:
      // R_visual = (R * D) / sqrt(D^2 - R^2)
      // This ensures the blue atmosphere glow hugs the exact visible horizon edge whether zoomed far out or super close in Horizon mode!
      const camDist = camera.position.length();
      const safeDist = Math.max(camDist, EARTH_RADIUS * 1.05);
      const visualHorizonRadius =
        (EARTH_RADIUS * safeDist) /
        Math.sqrt(safeDist * safeDist - EARTH_RADIUS * EARTH_RADIUS);
      haloMat.uniforms.uVisualRadius.value = visualHorizonRadius;

      // Keep the atmosphere glow plane facing the camera
      atmosphereBillboard.quaternion.copy(camera.quaternion);

      const halfW = currentWidth / 2;
      const halfH = currentHeight / 2;

      cameraDir.copy(camera.position).normalize();
      placedBoxes.length = 0;

      // Exact geometric horizon dot product: cos(theta_horizon) = R / D
      // Any surface point with dot(normal, cameraDir) > R / D is geometrically visible in front of the horizon!
      const geometricHorizonDot = EARTH_RADIUS / safeDist;

      for (let i = 0; i < labelEntries.length; i++) {
        const entry = labelEntries[i];

        const facingDot = entry.normal.dot(cameraDir);

        // Allow labels right up to the curved horizon crest (like Houston, United States, Calgary in Horizon mode!)
        let minDotThreshold = geometricHorizonDot + 0.035;
        if (entry.data.type === "city") {
          minDotThreshold =
            camDist > 26 ? geometricHorizonDot + 0.16 : geometricHorizonDot + 0.04;
        } else if (entry.data.type === "country" && entry.data.size === "sm") {
          minDotThreshold =
            camDist > 27 ? geometricHorizonDot + 0.18 : geometricHorizonDot + 0.05;
        }

        if (facingDot <= minDotThreshold) {
          entry.el.style.opacity = "0";
          continue;
        }

        tempProjVec.copy(entry.localPos).project(camera);
        const screenX = tempProjVec.x * halfW + halfW;
        const screenY = -tempProjVec.y * halfH + halfH;

        // Cull labels outside viewport bounds
        if (
          screenX < -60 ||
          screenX > currentWidth + 60 ||
          screenY < -40 ||
          screenY > currentHeight + 40
        ) {
          entry.el.style.opacity = "0";
          continue;
        }

        // Screen-space bounding box collision check
        const halfBoxW = entry.approxW * 0.5;
        const halfBoxH = entry.approxH * 0.5;
        const box = {
          x1: screenX - halfBoxW,
          y1: screenY - halfBoxH,
          x2: screenX + halfBoxW,
          y2: screenY + halfBoxH,
        };

        let collides = false;
        for (let j = 0; j < placedBoxes.length; j++) {
          const b = placedBoxes[j];
          if (box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1) {
            collides = true;
            break;
          }
        }

        if (collides) {
          entry.el.style.opacity = "0";
          continue;
        }

        placedBoxes.push(box);

        // Smooth fade-in near the globe's curved horizon
        const fadeRange = 0.14;
        const alpha = Math.min(1, (facingDot - minDotThreshold) / fadeRange);

        entry.el.style.opacity = alpha.toFixed(2);
        entry.el.style.transform = `translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0) translate(-50%, -50%)`;
      }

      renderer.render(scene, camera);
    };

    animate();

    // 10. RESIZE HANDLER
    const handleResize = () => {
      if (!container) return;
      const newW = container.clientWidth || window.innerWidth;
      const newH = container.clientHeight || window.innerHeight;
      camera.aspect = newW / newH;
      applyCameraViewOffset(newW, newH, currentOffsetYFactor);
      renderer.setSize(newW, newH);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      isDisposed = true;
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
      controls.removeEventListener("start", onUserInteractStart);
      controls.dispose();
      renderer.dispose();
      earthGeo.dispose();
      earthMat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      starTexture.dispose();
    };
  }, [initialLat, initialLng, autoRotate, autoRotateSpeed]);

  return (
    <div
      className={`relative w-full h-full overflow-hidden select-none ${className}`}
      style={{
        // Dynamically shift the radial space glow downward in Horizon mode so the blue space backdrop tracks the horizon dome
        background:
          viewMode === "horizon"
            ? "radial-gradient(circle at 50% 88%, #0d1d47 0%, #07112b 54%, #040817 82%, #02040a 100%)"
            : "radial-gradient(circle at 50% 50%, #0d1d47 0%, #07112b 48%, #040817 78%, #02040a 100%)",
        transition: "background 0.9s cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      {/* WebGL 3D Canvas Mount */}
      <div
        ref={mountRef}
        className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing"
      />

      {/* Crisp Geographical Typography Layer (Countries, Cities, Oceans) */}
      <div
        ref={labelsContainerRef}
        className="absolute inset-0 w-full h-full pointer-events-none overflow-hidden"
      />

      {/* Top-Right View Switcher (Full Globe vs Horizon View) */}
      {showViewToggle && (
        <div className="absolute top-5 right-5 z-20 flex items-center gap-1 p-1 rounded-xl bg-[#141720]/85 border border-white/10 backdrop-blur-md shadow-2xl">
          <button
            type="button"
            onClick={() => toggleViewMode("full")}
            title="Full Globe View"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-300 cursor-pointer ${
              viewMode === "full"
                ? "bg-blue-500/20 text-blue-300 border border-blue-400/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 border border-transparent"
            }`}
          >
            {/* Full 3D Globe Icon */}
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
              <path d="M2 12h20" />
            </svg>
            <span>Globe</span>
          </button>

          <button
            type="button"
            onClick={() => toggleViewMode("horizon")}
            title="Horizon Arc View"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-300 cursor-pointer ${
              viewMode === "horizon"
                ? "bg-blue-500/20 text-blue-300 border border-blue-400/30 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 border border-transparent"
            }`}
          >
            {/* Horizon Arc / Half-Moon Globe Icon matching DataFast */}
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 18a10 10 0 0 1 20 0" />
              <path d="M6 18a6 10 0 0 1 12 0" />
              <line x1="2" y1="18" x2="22" y2="18" />
            </svg>
            <span>Horizon</span>
          </button>
        </div>
      )}

      {/* Subtle loading transition */}
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-8 h-8 rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin" />
        </div>
      )}
    </div>
  );
}
