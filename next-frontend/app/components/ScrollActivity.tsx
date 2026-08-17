"use client";

import { useEffect } from "react";

const ACTIVE_CLASS = "scrollbar-scrolling";
const HIDE_DELAY_MS = 850;

/**
 * One capture-phase listener covers the document and every nested scroll area.
 * It only adds a transient class; native scrolling and layout remain untouched.
 */
export function ScrollActivity() {
  useEffect(() => {
    const timers = new WeakMap<HTMLElement, number>();

    const onScroll = (event: Event) => {
      const target = event.target;
      const element = target instanceof HTMLElement
        ? target
        : document.scrollingElement instanceof HTMLElement
          ? document.scrollingElement
          : document.documentElement;

      element.classList.add(ACTIVE_CLASS);
      const existing = timers.get(element);
      if (existing) window.clearTimeout(existing);
      timers.set(element, window.setTimeout(() => {
        element.classList.remove(ACTIVE_CLASS);
        timers.delete(element);
      }, HIDE_DELAY_MS));
    };

    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, []);

  return null;
}
