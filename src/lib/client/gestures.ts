/**
 * Touch gestures for the viewer, as Svelte actions. Both are extras on top of visible buttons.
 *
 * They use passive touch events and never set touch-action, so pinch-zoom and scrolling stay
 * the browser's: a swipe only counts with one finger, when the page isn't zoomed in, and when
 * it is clearly sideways.
 */
import type { Action } from 'svelte/action';

const SWIPE_MIN_PX = 60;
const LONG_PRESS_MS = 550;
const MOVE_TOLERANCE_PX = 10;

function zoomedIn(): boolean {
	return (window.visualViewport?.scale ?? 1) > 1.01;
}

export interface SwipeOptions {
	/** Finger moved right → the previous (newer) item. */
	onprev?: () => void;
	/** Finger moved left → the next (older) item. */
	onnext?: () => void;
}

export const swipe: Action<HTMLElement, SwipeOptions> = (node, initial) => {
	let opts = initial;
	let start: { x: number; y: number; t: number } | null = null;

	const onStart = (e: TouchEvent) => {
		start = e.touches.length === 1 && !zoomedIn() ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp } : null;
	};
	const onMove = (e: TouchEvent) => {
		if (e.touches.length > 1) start = null; // pinch
	};
	const onEnd = (e: TouchEvent) => {
		if (!start || e.changedTouches.length !== 1) return;
		const dx = e.changedTouches[0].clientX - start.x;
		const dy = e.changedTouches[0].clientY - start.y;
		const quick = e.timeStamp - start.t < 800;
		start = null;
		if (!quick || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dy) > Math.abs(dx) * 0.6 || zoomedIn()) return;
		if (dx > 0) opts.onprev?.();
		else opts.onnext?.();
	};

	node.addEventListener('touchstart', onStart, { passive: true });
	node.addEventListener('touchmove', onMove, { passive: true });
	node.addEventListener('touchend', onEnd, { passive: true });
	return {
		update(next) {
			opts = next;
		},
		destroy() {
			node.removeEventListener('touchstart', onStart);
			node.removeEventListener('touchmove', onMove);
			node.removeEventListener('touchend', onEnd);
		}
	};
};

export interface LongPressOptions {
	onpress: () => void;
	/** Also react to a touch long-press (default true). Off for videos, whose controls are held. */
	touch?: boolean;
}

/**
 * Long-press (touch) or right-click / the context-menu key on the element: the browser's own
 * menu is suppressed (it would save the small preview) and `onpress` runs instead.
 */
export const longPress: Action<HTMLElement, LongPressOptions> = (node, initial) => {
	let opts = initial;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let origin: { x: number; y: number } | null = null;

	const cancel = () => {
		clearTimeout(timer);
		origin = null;
	};
	const onStart = (e: TouchEvent) => {
		cancel();
		if (opts.touch === false || e.touches.length !== 1) return;
		origin = { x: e.touches[0].clientX, y: e.touches[0].clientY };
		timer = setTimeout(() => {
			origin = null;
			opts.onpress();
		}, LONG_PRESS_MS);
	};
	const onMove = (e: TouchEvent) => {
		if (!origin) return;
		const t = e.touches[0];
		if (e.touches.length > 1 || Math.hypot(t.clientX - origin.x, t.clientY - origin.y) > MOVE_TOLERANCE_PX) cancel();
	};
	const onContextMenu = (e: Event) => {
		e.preventDefault();
		cancel();
		opts.onpress();
	};

	node.addEventListener('touchstart', onStart, { passive: true });
	node.addEventListener('touchmove', onMove, { passive: true });
	node.addEventListener('touchend', cancel, { passive: true });
	node.addEventListener('touchcancel', cancel, { passive: true });
	node.addEventListener('contextmenu', onContextMenu);
	return {
		update(next) {
			opts = next;
		},
		destroy() {
			cancel();
			node.removeEventListener('touchstart', onStart);
			node.removeEventListener('touchmove', onMove);
			node.removeEventListener('touchend', cancel);
			node.removeEventListener('touchcancel', cancel);
			node.removeEventListener('contextmenu', onContextMenu);
		}
	};
};
