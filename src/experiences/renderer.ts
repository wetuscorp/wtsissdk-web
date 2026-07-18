import type { AvailableExperience, ExperienceAction, ExperienceLocalizedContent } from "../types";

export interface RenderCallbacks {
  locale: string;
  onAction(action: ExperienceAction): void;
  onDismiss(reason: "dismissed" | "auto_closed"): void;
  onImpression(): void;
}

export interface RenderHandle {
  dismiss(reason?: "dismissed" | "auto_closed", notify?: boolean): void;
}

export async function renderExperience(
  experience: AvailableExperience,
  callbacks: RenderCallbacks,
): Promise<RenderHandle> {
  if (typeof document === "undefined") throw new Error("DOCUMENT_UNAVAILABLE");
  const translated = selectTranslation(experience.content.translations, callbacks.locale);
  if (!translated) throw new Error("CONTENT_LOCALE_UNAVAILABLE");

  const host = document.createElement("div");
  host.dataset.wtsExperience = experience.exposureId;
  const root = host.attachShadow({ mode: "closed" });
  const backdrop = document.createElement("div");
  backdrop.className = `backdrop placement-${experience.placement}`;
  const surface = document.createElement("section");
  surface.className = `surface theme-${experience.content.themePreset}`;
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-modal", experience.placement === "modal" ? "true" : "false");
  surface.setAttribute("aria-labelledby", `wts-title-${experience.exposureId}`);
  surface.setAttribute("aria-describedby", `wts-description-${experience.exposureId}`);
  surface.tabIndex = -1;

  root.append(createStyle(), backdrop);
  backdrop.append(surface);
  let requestClose = (reason: "dismissed" | "auto_closed") => callbacks.onDismiss(reason);
  appendContent(surface, experience, translated, {
    ...callbacks,
    onDismiss: (reason) => requestClose(reason),
  });
  document.body.append(host);

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;
  let impressed = false;
  let visibleSince: ReturnType<typeof setTimeout> | undefined;
  let autoCloseTimer: ReturnType<typeof setTimeout> | undefined;

  const close = (reason: "dismissed" | "auto_closed" = "dismissed", notify = true) => {
    if (closed) return;
    closed = true;
    observer?.disconnect();
    if (visibleSince) clearTimeout(visibleSince);
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
    document.removeEventListener("keydown", onKeydown, true);
    host.remove();
    if (previousFocus) previousFocus.focus();
    if (notify) callbacks.onDismiss(reason);
  };
  requestClose = close;

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && experience.content.closeable) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(surface);
    if (focusable.length === 0) {
      event.preventDefault();
      surface.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && root.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && root.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener("keydown", onKeydown, true);
  const observer =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            const visible = (entries[0]?.intersectionRatio ?? 0) >= 0.5;
            if (!visible && visibleSince) {
              clearTimeout(visibleSince);
              visibleSince = undefined;
            }
            if (visible && !visibleSince && !impressed) {
              visibleSince = setTimeout(() => {
                if (closed || impressed) return;
                impressed = true;
                callbacks.onImpression();
              }, 1_000);
            }
          },
          { threshold: [0, 0.5, 1] },
        );
  const delay = experience.content.delaySeconds * 1_000;
  if (delay > 0) {
    host.style.visibility = "hidden";
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!closed) host.style.visibility = "visible";
        resolve();
      }, delay);
    });
  }
  if (observer) observer.observe(surface);
  else {
    visibleSince = setTimeout(() => {
      if (!closed && !impressed) {
        impressed = true;
        callbacks.onImpression();
      }
    }, 1_000);
  }
  surface.focus();
  if (experience.content.autoCloseSeconds) {
    autoCloseTimer = setTimeout(
      () => close("auto_closed"),
      experience.content.autoCloseSeconds * 1_000,
    );
  }
  return { dismiss: close };
}

function appendContent(
  surface: HTMLElement,
  experience: AvailableExperience,
  content: ExperienceLocalizedContent,
  callbacks: RenderCallbacks,
) {
  if (experience.assetUrl) {
    const image = document.createElement("img");
    image.className = "asset";
    image.src = experience.assetUrl;
    image.alt = "";
    image.loading = "eager";
    image.decoding = "async";
    surface.append(image);
  }
  const body = document.createElement("div");
  body.className = "body";
  const title = document.createElement("h2");
  title.id = `wts-title-${experience.exposureId}`;
  title.textContent = content.title;
  body.append(title);
  const description = document.createElement("p");
  description.id = `wts-description-${experience.exposureId}`;
  description.textContent = content.description;
  body.append(description);
  const actions = document.createElement("div");
  actions.className = "actions";
  for (const [index, action] of [content.primaryAction, content.secondaryAction].entries()) {
    if (!action) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === 0 ? "primary" : "secondary";
    button.textContent = action.label;
    button.addEventListener("click", () => callbacks.onAction(action));
    actions.append(button);
  }
  if (actions.childElementCount > 0) body.append(actions);
  surface.append(body);
  if (experience.content.closeable) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", () => callbacks.onDismiss("dismissed"));
    surface.append(close);
  }
}

function selectTranslation(
  translations: Record<string, ExperienceLocalizedContent>,
  requestedLocale: string,
) {
  return (
    translations[requestedLocale] ??
    translations[requestedLocale.split("-")[0] ?? ""] ??
    Object.values(translations)[0]
  );
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],[tabindex]"),
  ].filter((element) => element.tabIndex >= 0);
}

function createStyle() {
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
    .backdrop { position: fixed; inset: 0; display: flex; padding: 20px; box-sizing: border-box;
      font-family: Manrope, ui-sans-serif, system-ui, sans-serif; color: #0b1220; pointer-events: none; }
    .placement-modal { align-items: center; justify-content: center; background: rgba(2, 8, 23, .52); pointer-events: auto; }
    .placement-top_banner { align-items: flex-start; justify-content: center; }
    .placement-bottom_banner { align-items: flex-end; justify-content: center; }
    .placement-slide_in { align-items: flex-end; justify-content: flex-end; }
    .surface { pointer-events: auto; position: relative; width: min(100%, 520px); overflow: hidden;
      border-radius: 20px; box-shadow: 0 24px 80px rgba(2,8,23,.28); background: #fff; color: #0b1220;
      border: 1px solid rgba(148,163,184,.28); transform: translateZ(0); }
    .placement-top_banner .surface,.placement-bottom_banner .surface { width: min(100%, 920px); border-radius: 14px; }
    .placement-slide_in .surface { width: min(100%, 400px); }
    .theme-dark { background: #071120; color: #f8fafc; border-color: rgba(148,163,184,.2); }
    .theme-brand { background: linear-gradient(145deg,#071b34,#0b3260); color: #f8fafc; border-color: rgba(34,211,238,.25); }
    .asset { display: block; width: 100%; max-height: 280px; object-fit: cover; }
    .body { padding: 28px; }
    h2 { margin: 0; font: 700 24px/1.2 Manrope,ui-sans-serif,system-ui,sans-serif; letter-spacing: -.025em; }
    p { margin: 12px 0 0; font: 400 15px/1.6 Manrope,ui-sans-serif,system-ui,sans-serif; opacity: .78; white-space: pre-wrap; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
    button { border: 0; border-radius: 10px; min-height: 42px; padding: 10px 16px; cursor: pointer;
      font: 700 14px/1 Manrope,ui-sans-serif,system-ui,sans-serif; }
    .primary { background: #13b8dc; color: #04131d; }
    .secondary { background: rgba(148,163,184,.16); color: inherit; }
    .close { position: absolute; top: 12px; right: 12px; min-height: 36px; width: 36px; padding: 0;
      border-radius: 999px; background: rgba(15,23,42,.12); color: inherit; font-size: 22px; }
    button:focus-visible { outline: 3px solid #22d3ee; outline-offset: 3px; }
    @media (prefers-reduced-motion: no-preference) {
      .surface { animation: wts-enter .2s cubic-bezier(.2,.8,.2,1) both; }
      @keyframes wts-enter { from { opacity: 0; transform: translateY(10px) scale(.985); } }
    }
    @media (max-width: 480px) { .backdrop { padding: 12px; } .body { padding: 22px; } h2 { font-size: 21px; } }
  `;
  return style;
}
