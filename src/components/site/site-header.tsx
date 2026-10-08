"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import PillNav from "@/components/reactbits/PillNav";
import { Wordmark } from "@/components/brand/wordmark";
import { ButtonLink } from "@/components/ui/button";
import { XLink } from "@/components/brand/x-link";
import { CaChip } from "@/components/brand/ca-chip";

const NAV = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#fees", label: "Fees" },
  { href: "/#run-a-node", label: "Run a node" },
  { href: "/#token", label: "Token" },
  { href: "/#faq", label: "FAQ" },
  { href: "/proof", label: "Proof" },
];

/** Scroll-spy for the landing anchors: the pill nav's dot follows the section being read. */
function useActiveSection() {
  const [active, setActive] = useState("");
  useEffect(() => {
    const ids = NAV.filter((n) => n.href.includes("#")).map((n) => n.href.split("#")[1]);
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(`/#${visible[0].target.id}`);
      },
      { rootMargin: "-35% 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    const onTop = () => window.scrollY < 200 && setActive("");
    window.addEventListener("scroll", onTop, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onTop);
    };
  }, []);
  return active;
}

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const active = useActiveSection();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-colors duration-200 ${
        scrolled || open ? "border-line bg-coal/95" : "border-transparent bg-coal/0"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-6 px-4 sm:px-6">
        <Wordmark />
        <div className="hidden md:block">
          <PillNav
            items={NAV}
            activeHref={active}
            linkComponent={Link}
            theme="dark"
            layout="joined"
            size="sm"
            surface="solid"
            itemStyle="plain"
            hoverEffect="glide"
            indicator="dot"
            barColor="#121212"
            textColor="#9b9b9b"
            highlightColor="#1d1d1d"
            highlightTextColor="#ededed"
            collapse="never"
            intro={false}
            ariaLabel="Main"
          />
        </div>
        <div className="flex items-center gap-2">
          <CaChip className="hidden lg:inline-flex" />
          <XLink />
          <ButtonLink href="/nodes" size="sm" className="hidden sm:inline-flex">
            Launch App
          </ButtonLink>
          <button
            ref={buttonRef}
            type="button"
            className="inline-grid size-9 place-items-center rounded-m border border-line text-text md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>
      {open ? (
        <div id="mobile-nav" className="fixed inset-x-0 top-16 bottom-0 z-40 border-t border-line bg-coal md:hidden">
          <nav aria-label="Mobile" className="flex flex-col px-4 py-4">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className="border-b border-line py-4 text-lg text-text"
              >
                {n.label}
              </Link>
            ))}
            <div className="border-b border-line py-4">
              <CaChip />
            </div>
            <XLink withLabel className="border-b border-line py-4 text-lg" />
            <ButtonLink href="/nodes" size="lg" className="mt-6" onClick={() => setOpen(false)}>
              Launch App
            </ButtonLink>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
