import { div } from "gpui-kit";

// Arrival motion shared by the chat and the side chat. A holder keeps `fresh` (ids drawn hidden this moment)
// and `delay` (each one's stagger), so several arrivals come in one after another.
export const STAGGER = 70;

// Marks elements as just arrived. They stay hidden long enough to be drawn once, then animate to place.
export function flash(holder, cx, ids) {
  if (!ids.length) return;
  ids.forEach((id, i) => { holder.fresh.add(id); holder.delay.set(id, Math.min(i, 4) * STAGGER); });
  cx.timer.after(80, (cx) => { for (const id of ids) holder.fresh.delete(id); cx.notify(); });
  cx.timer.after(1500, () => { for (const id of ids) holder.delay.delete(id); });
}

// Arrivals fade in and rise `lift` px. The id keeps each one's motion attached to it when the list around it shifts.
export function appear(el, id, holder, lift = 10) {
  const hidden = holder.fresh.has(id);
  const delay = holder.delay.get(id) ?? 0;
  return div().id(`ap-${id}`).w_full().relative().top(hidden ? lift : 0).opacity(hidden ? 0 : 1)
    .transition("opacity", { duration: 320, delay, easing: "ease-out" })
    .transition("top", { duration: 420, delay, easing: "ease-out" })
    .child(el);
}
