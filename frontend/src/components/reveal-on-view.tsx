import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Fades + rises its children into view the first time they scroll into the
 * viewport (once; it never hides them again). Wrap cards in a long page so
 * they arrive as the reader reaches them instead of all at once on mount.
 */
export function RevealOnView({ children, className }: { children: ReactNode; className?: string }) {
  const [visible, setVisible] = useState(false);
  const elementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { threshold: 0.12, rootMargin: "0px 0px -8%" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={elementRef}
      className={cn(
        "transform-gpu transition-all duration-700 ease-out motion-reduce:transform-none motion-reduce:transition-none",
        visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-8 scale-95 opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
