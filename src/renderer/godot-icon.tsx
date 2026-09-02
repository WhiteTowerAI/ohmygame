import type { ImgHTMLAttributes } from "react";

const godotIconUrl = new URL("./assets/godot.svg", import.meta.url).href;

export function GodotIcon({ size = 13, ...props }: ImgHTMLAttributes<HTMLImageElement> & { size?: number }) {
  return <img className="tool-brand-icon tool-brand-godot" src={godotIconUrl} width={size} height={size} alt="" {...props} />;
}
