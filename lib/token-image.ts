export function tokenImageUrl(source: string) {
  if (source.startsWith("/") || source.startsWith("data:") || source.startsWith("blob:")) return source;
  return `/api/token-image?url=${encodeURIComponent(source)}`;
}
