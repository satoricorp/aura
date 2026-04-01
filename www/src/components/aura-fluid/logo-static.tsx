import Image from "next/image";

export function StaticVersion() {
  return (
    <div className="h-screen w-screen bg-black flex items-center justify-center">
      <Image
        src="/logo-color.png"
        alt="Aura"
        width={1122}
        height={794}
        className="max-w-full h-auto w-auto"
        priority
      />
    </div>
  );
}
