"use client";

import Image, { type ImageLoaderProps } from "next/image";
import { tokenImageUrl } from "@/lib/token-image";

function directImageLoader({ src }: ImageLoaderProps) {
  return src;
}

export function ExternalTokenImage({ src, name }: { src: string; name: string }) {
  return <Image loader={directImageLoader} unoptimized src={tokenImageUrl(src)} alt={`${name} icon`} width={48} height={48} />;
}
