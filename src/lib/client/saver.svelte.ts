/**
 * State of "Save to my phone" for one item, shared by every button that saves it (the viewer's
 * bar and its Save sheet), so the file is fetched once and only one copy is held in memory.
 * Create one per item; call start() once mounted and dispose() when leaving the item.
 */
import type { SaveTargetDTO } from './dto';
import {
	PREFETCH_DELAY_MS,
	canShareFiles,
	detectPlatform,
	fetchAsFile,
	saveDataOn,
	saveMode,
	shareFiles,
	shouldPrefetch,
	type SaveMode
} from './save';

export type SavePhase = 'idle' | 'preparing' | 'ready' | 'error';

export class Saver {
	readonly target: SaveTargetDTO;
	/** 'download' until start() has looked at the device (and always without JavaScript). */
	mode = $state<SaveMode>('download');
	phase = $state<SavePhase>('idle');
	/** A prefetch is running or done without being asked for: the label stays "Save to my phone". */
	quiet = $state(false);
	pct = $state(0);
	/** For screen readers (role=status). */
	message = $state('');

	#file: File | null = null;
	#controller: AbortController | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(target: SaveTargetDTO) {
		this.target = target;
	}

	/** Picks share vs download for this device; with `prefetch`, fetches small photos after 1.5 s. */
	start(prefetch: boolean): void {
		this.mode = saveMode(this.target, detectPlatform(), canShareFiles());
		if (this.mode === 'share' && prefetch && shouldPrefetch(this.target, saveDataOn())) {
			this.#timer = setTimeout(() => void this.#prepare(true), PREFETCH_DELAY_MS);
		}
	}

	dispose(): void {
		clearTimeout(this.#timer);
		this.#controller?.abort();
		this.#file = null;
	}

	/** A tap on a share-mode button. Resolves true once the share sheet was used. */
	async tap(): Promise<boolean> {
		if (this.phase === 'ready' && this.#file) return this.#share(this.#file);
		if (this.phase === 'preparing') {
			this.quiet = false; // a quiet prefetch is under way: show its progress now
		} else {
			void this.#prepare(false);
		}
		return false;
	}

	async #prepare(quietly: boolean): Promise<void> {
		if (this.phase === 'preparing') return;
		this.quiet = quietly;
		this.phase = 'preparing';
		this.pct = 0;
		this.#controller = new AbortController();
		try {
			this.#file = await fetchAsFile(this.target, (p) => (this.pct = p), this.#controller.signal);
			this.phase = 'ready';
			if (!this.quiet) this.message = 'Ready. Tap to save.';
		} catch (e) {
			if ((e as DOMException).name === 'AbortError') return;
			this.phase = this.quiet ? 'idle' : 'error';
			if (!this.quiet) this.message = "That didn't work. Please check your connection and tap to try again.";
		}
	}

	async #share(file: File): Promise<boolean> {
		try {
			if ((await shareFiles([file])) === 'shared') {
				this.message = 'Done!';
				return true;
			}
		} catch {
			// Safari refused (too long since the tap): the next tap shares straight away.
			this.quiet = false;
			this.message = 'Tap to save.';
		}
		return false;
	}
}
