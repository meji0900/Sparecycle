import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const buttonStyles = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-m text-sm font-medium transition-[background-color,border-color,color,opacity] duration-150 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary: "bg-signal text-signal-ink hover:bg-[#19d41e]",
        secondary: "border border-line-strong bg-transparent text-text hover:border-[rgba(255,255,255,0.32)] hover:bg-white/[0.03]",
        quiet: "text-muted hover:text-text",
      },
      size: {
        sm: "h-8 px-3",
        md: "h-10 px-4",
        lg: "h-11 px-5 text-[15px]",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

type Variants = VariantProps<typeof buttonStyles>;

export function Button({ className, variant, size, ...props }: ComponentProps<"button"> & Variants) {
  return <button className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

export function ButtonLink({ className, variant, size, ...props }: ComponentProps<typeof Link> & Variants) {
  return <Link className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}
