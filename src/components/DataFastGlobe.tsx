"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as topojson from "topojson-client";
import { geoEquirectangular, geoPath } from "d3-geo";
import { GEO_LABELS, GeoPlaceLabel } from "@/data/geo-labels";

export interface DataFastGlobeProps {
  /** Initial latitude of the globe center (default: 15 - Europe/Africa/Atlantic view like DataFast screenshot) */
  initialLat?: number;
  /** Initial longitude of the globe center (default: -8 - Europe/Africa/Atlantic view) */
  initialLng?: number;
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
  autoRotate = false,
  autoRotateSpeed = 0.35,
  className = "",
}: DataFastGlobeProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelsContainerRef = useRef<HTMLDivElement | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

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
    // Closer initial distance so the globe fills the viewport vertically just like the DataFast screenshot
    const INITIAL_DISTANCE = 22.8;

    const initialCamPos = latLngToVector3(initialLat, initialLng, INITIAL_DISTANCE);
    camera.position.copy(initialCamPos);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Important: No toneMapping so exact hex colors (#282b33 land, #13161f ocean) render 1:1 without darkening
    renderer.toneMapping = THREE.NoToneMapping;

    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // 2. ORBIT CONTROLS
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.75;
    controls.minDistance = 13.5;
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

    // 5. LAYER 2: THICK, SOFT DIFFUSED ATMOSPHERE HALO (Billboard Shader Plane behind the Earth)
    // Instead of a small sphere with a sharp geometric edge, a camera-facing billboard plane
    // computes exact radial distance from the Earth's horizon in world units, giving a super thick,
    // silky-smooth Gaussian atmospheric glow that fades seamlessly into deep space like Mapbox setFog!
    const HALO_PLANE_SIZE = EARTH_RADIUS * 5.2;
    const haloGeo = new THREE.PlaneGeometry(HALO_PLANE_SIZE, HALO_PLANE_SIZE);
    const haloMat = new THREE.ShaderMaterial({
      uniforms: {
        uEarthRadius: { value: EARTH_RADIUS },
      },
      vertexShader: `
        varying vec2 vLocalPos;
        void main() {
          vLocalPos = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uEarthRadius;
        varying vec2 vLocalPos;

        void main() {
          // Normalized distance from globe center: 1.0 = exact horizon edge of Earth
          float r = length(vLocalPos) / uEarthRadius;

          // Distance outside the Earth's limb
          float distFromLimb = max(0.0, r - 0.985);

          // 1) Bright, concentrated royal-blue inner horizon glow right along the Earth's edge
          float innerRim = exp(-distFromLimb * 4.8) * 0.78;

          // 2) Wide, thick, soft sapphire-blue outer atmospheric scatter into deep space
          float outerScatter = exp(-distFromLimb * 1.45) * 0.56;

          // Smoothly ensure zero clipping at the far edges of the plane
          float edgeFade = 1.0 - smoothstep(1.85, 2.55, r);

          float totalAlpha = (innerRim + outerScatter) * edgeFade;

          // Color gradient: vibrant royal blue right at the horizon -> deep space navy further out
          vec3 innerBlue = vec3(0.18, 0.42, 0.88); // #2e6be0
          vec3 midBlue   = vec3(0.09, 0.23, 0.56); // #173b8f
          vec3 deepBlue  = vec3(0.03, 0.08, 0.22); // #081438

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
    // Placeholder texture until 8K canvas finishes
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

          // Keep countries (#282b33) and borders (#4a4e58) clearly visible across the whole globe!
          // Center is slightly brighter (1.08), and edges stay well-lit (0.78) so countries never look pitch black
          float shade = mix(0.76, 1.06, pow(facing, 0.45));
          vec3 baseColor = texColor.rgb * shade;

          // Soft atmospheric blue inner rim on the globe's horizon so the Earth blends seamlessly into the outer halo
          float rim = pow(1.0 - facing, 3.2);
          vec3 rimColor = vec3(0.15, 0.36, 0.82) * rim * 0.42;

          gl_FragColor = vec4(baseColor + rimColor, 1.0);
        }
      `,
    });

    const earthMesh = new THREE.Mesh(earthGeo, earthMat);
    globeGroup.add(earthMesh);

    // 7. LOAD TOPOJSON & RENDER HIGH-RES EQUIRRECTANGULAR MAP (Exact DataFast Country & Border Colors)
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

        // 1) Deep dark navy-slate ocean background matching DataFast screenshot (#13161f)
        ctx.fillStyle = "#13161f";
        ctx.fillRect(0, 0, W, H);

        const projection = geoEquirectangular()
          .translate([W / 2, H / 2])
          .scale(W / (2 * Math.PI));

        const pathGenerator = geoPath(projection, ctx);

        // 2) Distinct dark charcoal-grey landmass fill (#282b33) so continents stand out clearly from oceans
        ctx.beginPath();
        pathGenerator(countriesGeo);
        ctx.fillStyle = "#282b33";
        ctx.fill();

        // 3) Crisp country borders (#494e59) matching Algeria, Mali, Libya, etc. in screenshot
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = "#494e59";
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();

        const highResTexture = new THREE.CanvasTexture(mapCanvas);
        // Keep linear color space so exact hex values are preserved in our custom ShaderMaterial
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
      worldPos: THREE.Vector3;
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
        // Country label
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

      const worldPos = latLngToVector3(item.lat, item.lng, EARTH_RADIUS * 1.003);
      const normal = worldPos.clone().normalize();

      return {
        data: item,
        el,
        worldPos,
        normal,
        priority,
        approxW,
        approxH,
      };
    });

    // Sort labels by priority descending so major countries/oceans win screen space over dense small countries
    labelEntries.sort((a, b) => b.priority - a.priority);

    // 9. ANIMATION, BILLBOARD ORIENTATION & COLLISION-FREE LABEL PROJECTION LOOP
    const tempProjVec = new THREE.Vector3();
    const cameraDir = new THREE.Vector3();
    const placedBoxes: { x1: number; y1: number; x2: number; y2: number }[] = [];

    const animate = () => {
      if (isDisposed) return;
      animationFrameId = requestAnimationFrame(animate);

      controls.update();

      // Always keep the thick atmosphere glow plane facing the camera right behind the Earth center
      atmosphereBillboard.quaternion.copy(camera.quaternion);

      const currentWidth = container.clientWidth;
      const currentHeight = container.clientHeight;
      const halfW = currentWidth / 2;
      const halfH = currentHeight / 2;

      const camDist = camera.position.length();
      cameraDir.copy(camera.position).normalize();
      placedBoxes.length = 0;

      for (let i = 0; i < labelEntries.length; i++) {
        const entry = labelEntries[i];

        // 1.0 = facing camera dead center, 0.0 = horizon limb
        const facingDot = entry.normal.dot(cameraDir);

        // Cut off labels near the curved horizon edge so they don't bunch up on the rim
        let minDotThreshold = 0.26;
        if (entry.data.type === "city") {
          minDotThreshold = camDist > 28 ? 0.45 : 0.28;
        } else if (entry.data.type === "country" && entry.data.size === "sm") {
          minDotThreshold = camDist > 29 ? 0.48 : 0.3;
        }

        if (facingDot <= minDotThreshold) {
          entry.el.style.opacity = "0";
          continue;
        }

        tempProjVec.copy(entry.worldPos).project(camera);
        const screenX = tempProjVec.x * halfW + halfW;
        const screenY = -tempProjVec.y * halfH + halfH;

        // Screen-space bounding box collision check so European countries never overlap each other
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
        const fadeRange = 0.2;
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
      camera.updateProjectionMatrix();
      renderer.setSize(newW, newH);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      isDisposed = true;
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
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
        // Deep space universe gradient matching DataFast's outer space color (#060b19 -> #02040a)
        background:
          "radial-gradient(circle at 50% 50%, #0d1d47 0%, #07112b 48%, #040817 78%, #02040a 100%)",
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

      {/* Subtle loading transition */}
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-8 h-8 rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin" />
        </div>
      )}
    </div>
  );
}
