import { Globe, ArrowDown, Minus } from "lucide-react";

export function GlobeDownload({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <span className={`relative inline-block size-full ${className}`}>
      <Globe className="size-full text-muted-foreground" />
      <Minus className="absolute text-blue-700 left-[30%] top-[42%] text-muted-foreground" strokeWidth={2} />
      <ArrowDown
        className="absolute text-blue-700 left-[47%] top-[17%]"
        style={{ width: "80%", height: "80%" }}
        strokeWidth={3}
      />
    </span>
  );
}