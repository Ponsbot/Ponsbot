"use client";

import Image, { type ImageLoaderProps } from "next/image";

function directImageLoader({ src }: ImageLoaderProps) {
  return src;
}

export function ExternalTokenImage({ src, name }: { src: string; name: string }) {
  return <Image loader={directImageLoader} unoptimized src={src} alt={`${name} icon`} width={48} height={48} />;
}
