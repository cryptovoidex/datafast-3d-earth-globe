import DataFastGlobe from "@/components/DataFastGlobe";

export default function Home() {
  return (
    <main className="relative w-screen h-screen overflow-hidden bg-[#02040a]">
      <DataFastGlobe initialLat={15} initialLng={-8} autoRotate={false} />
    </main>
  );
}
