"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return <div className="mobile-nav" ref={menuRef}>
    <button className="mobile-menu-toggle" type="button" aria-label="Open navigation menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span /><span /><span /></button>
    {open ? <div className="mobile-menu">
      <Link href="/" onClick={() => setOpen(false)}>HOME</Link>
      <Link href="/how-it-works" onClick={() => setOpen(false)}>HOW IT WORKS</Link>
      <Link href="/#launches" onClick={() => setOpen(false)}>LAUNCHES</Link>
      <a href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer"><Image src="/x.webp" alt="" width={14} height={14} /> @ponsbotfamily</a>
      <a href="/api/auth/x/start">MY WALLET</a>
    </div> : null}
  </div>;
}
