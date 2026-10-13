<!--
	Saving a whole album (docs/PLAN.md "Downloads"):
	- computers: "Download all (for computers)", a ZIP (also the fallback without JavaScript);
	- iPhone/iPad: "Save all" shares batches of 10 ("Save next 10"), each prepared ahead of the tap;
	- Android (and phones that can't share files): one download every 500 ms.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import type { SaveTargetDTO } from '#lib/client/dto';
	import {
		ANDROID_DOWNLOAD_GAP_MS,
		canShareFiles,
		detectPlatform,
		fetchAsFile,
		planSaveAll,
		shareFiles,
		startDownload,
		type SaveAllStep
	} from '#lib/client/save';

	interface Props {
		albumId: number;
		itemCount: number;
	}

	let { albumId, itemCount }: Props = $props();

	type Mode = 'zip' | 'share' | 'sequential';
	type Phase = 'idle' | 'preparing' | 'ready' | 'saving' | 'done' | 'error';

	let mode = $state<Mode>('zip');
	let phase = $state<Phase>('idle');
	let steps = $state<SaveAllStep<SaveTargetDTO>[]>([]);
	let index = $state(0);
	let pct = $state(0);
	let saved = $state(0);
	let total = $state(0);
	let files: File[] = [];
	let controller: AbortController | null = null;
	/** Set when the page goes away: stops fetching and the one-by-one downloads. */
	let gone = false;

	onMount(() => {
		const platform = detectPlatform();
		mode = platform === 'desktop' ? 'zip' : platform === 'ios' && canShareFiles() ? 'share' : 'sequential';
		return () => {
			gone = true;
			controller?.abort();
		};
	});

	const step = $derived(steps[index]);
	const stepCount = $derived(step ? (step.kind === 'share' ? step.items.length : 1) : 0);
	/** "10", "the next 10", "it", "the next one". */
	const what = $derived(
		saved === 0 ? (stepCount > 1 ? String(stepCount) : 'it') : stepCount > 1 ? `the next ${stepCount}` : 'the next one'
	);
	const buttonLabel = $derived(
		step?.kind === 'download'
			? saved === 0
				? 'Tap to save the video'
				: 'Save the next video'
			: saved === 0
				? `Tap to save ${what}`
				: stepCount > 1
					? `Save next ${stepCount}`
					: 'Save the next one'
	);

	async function loadTargets(): Promise<SaveTargetDTO[]> {
		const res = await fetch(`/album/${albumId}/files`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as SaveTargetDTO[];
	}

	/** Fetches the current step's files so the next tap can share them at once. */
	async function prepare() {
		const s = steps[index];
		files = [];
		if (!s) {
			phase = 'done';
			return;
		}
		if (s.kind === 'download') {
			phase = 'ready';
			return;
		}
		phase = 'preparing';
		pct = 0;
		controller = new AbortController();
		const batchBytes = s.items.reduce((n, t) => n + (t.size ?? 0), 0) || 1;
		let before = 0; // bytes of the files already fetched
		try {
			for (const t of s.items) {
				const size = t.size ?? 0;
				const onProgress = (p: number) => (pct = Math.min(99, Math.floor(((before + (size * p) / 100) * 100) / batchBytes)));
				files.push(await fetchAsFile(t, onProgress, controller.signal));
				before += size;
			}
			phase = 'ready';
		} catch (e) {
			if ((e as DOMException).name !== 'AbortError') phase = 'error';
		}
	}

	function advance() {
		saved += stepCount;
		index += 1;
		void prepare();
	}

	async function start() {
		phase = 'preparing';
		pct = 0;
		try {
			const targets = await loadTargets();
			total = targets.length;
			saved = 0;
			if (mode === 'share') {
				steps = planSaveAll(targets);
				index = 0;
				await prepare();
			} else {
				phase = 'saving';
				for (const t of targets) {
					if (gone) return;
					startDownload(t.downloadUrl, t.name);
					saved += 1;
					await new Promise((r) => setTimeout(r, ANDROID_DOWNLOAD_GAP_MS));
				}
				phase = 'done';
			}
		} catch {
			phase = 'error';
		}
	}

	async function tap() {
		const s = steps[index];
		if (phase === 'error') {
			if (steps.length > 0) void prepare();
			else void start();
			return;
		}
		if (phase !== 'ready' || !s) return;
		if (s.kind === 'download') {
			startDownload(s.item.downloadUrl, s.item.name);
			advance();
			return;
		}
		try {
			if ((await shareFiles(files)) === 'shared') advance();
		} catch {
			// Safari wants a fresh tap; the files are still ready.
		}
	}

	const status = $derived.by(() => {
		if (phase === 'preparing') return steps.length ? `Getting ${what} ready… ${pct}%` : 'Getting ready…';
		if (phase === 'saving') return `Saving ${saved} of ${total}…`;
		if (phase === 'done')
			return mode === 'share' ? `All done! ${saved} saved.` : `Done! ${total === 1 ? 'It is' : `All ${total} are`} in your Downloads.`;
		if (phase === 'error') return "That didn't work. Please check your connection and try again.";
		if (phase === 'ready' && saved > 0) return `${saved} of ${total} saved.`;
		return '';
	});
</script>

{#if itemCount > 0}
	<div class="save-all">
		{#if mode === 'zip'}
			<a class="btn" href="/album/{albumId}/download" download>
				<Icon name="computer" /> Download all (for computers)
			</a>
		{:else if phase === 'idle'}
			<button type="button" class="btn" onclick={start}><Icon name="save" /> Save all to my phone</button>
		{:else if mode === 'share' && (phase === 'ready' || phase === 'preparing')}
			<button type="button" class="btn btn-primary" onclick={tap} disabled={phase === 'preparing'}>
				{#if phase === 'preparing'}
					<span class="spinner" aria-hidden="true"></span> Getting ready…
				{:else}
					<Icon name="save" /> {buttonLabel}
				{/if}
			</button>
		{:else if phase === 'error'}
			<button type="button" class="btn" onclick={tap}><Icon name="retry" /> Try again</button>
		{/if}
		<p class="status" role="status">{status}</p>
	</div>
{/if}

<style>
	.save-all {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	.status {
		margin: 0;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.status:empty {
		display: none;
	}
</style>
