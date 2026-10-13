<!--
	Uploads that aren't in the album grid yet (only their uploader and the admin see these).
	Polls /api/status while anything is still on its way and calls `onsettled` once everything has
	finished, so the page can reload the grid.
-->
<script lang="ts">
	import Icon from './Icon.svelte';
	import type { PendingDTO } from '#lib/client/dto';
	import type { MediaStatusDTO } from '#lib/shared/media-types';
	import { isFinished, pollStatus, retryUpload, statusLine } from '#lib/client/status';

	interface Props {
		items: PendingDTO[];
		adminName: string;
		onsettled?: () => void;
	}

	let { items, adminName, onsettled }: Props = $props();

	/** Latest /api/status answer per id (newer than the page data). */
	let live = $state<Record<string, MediaStatusDTO>>({});
	let retrying = $state<Record<string, boolean>>({});

	const rows = $derived(
		items.map((i) => {
			const s = live[i.id];
			return {
				...i,
				status: s?.status ?? i.status,
				kind: s?.kind ?? i.kind,
				errorCode: s?.errorCode ?? (s ? null : i.errorCode),
				posterUrl: s?.posterUrl ?? i.posterUrl,
				pct: s?.pct,
				etaS: s?.etaS,
				queuePos: s?.queuePos
			};
		})
	);
	const unfinished = $derived(rows.filter((r) => !isFinished(r.status)).map((r) => r.id));
	const pollKey = $derived(unfinished.join(','));
	let changed = false;

	$effect(() => {
		const ids = pollKey ? pollKey.split(',') : [];
		if (ids.length === 0) {
			if (changed) {
				changed = false;
				onsettled?.();
			}
			return;
		}
		return pollStatus(ids, (answer) => {
			const next = { ...live };
			for (const r of answer) {
				if (next[r.id]?.status !== r.status) changed = true;
				next[r.id] = r;
			}
			live = next;
		});
	});

	async function tryAgain(id: string) {
		retrying = { ...retrying, [id]: true };
		const status = await retryUpload(id);
		retrying = { ...retrying, [id]: false };
		if (status) live = { ...live, [id]: { ...(live[id] ?? { id }), id, status, errorCode: undefined } };
	}
</script>

<ul class="pending" aria-label="Still on their way">
	{#each rows as row (row.id)}
		{@const line = statusLine(row, adminName)}
		<li class="item card">
			<span class="thumb">
				{#if row.posterUrl}
					<img src={row.posterUrl} alt="" width="96" height="96" />
				{:else}
					<Icon name={row.kind === 'video' ? 'video' : 'photo'} size="2em" />
				{/if}
			</span>
			<span class="body">
				<span class="name">{row.name}</span>
				<span class="line {line.tone}" role="status">
					{#if line.tone === 'busy'}<span class="spinner" aria-hidden="true"></span>{/if}
					{line.text}
				</span>
				{#if line.detail}<span class="detail">{line.detail}</span>{/if}
				{#if line.tone === 'retry'}
					<button class="btn" type="button" disabled={retrying[row.id]} onclick={() => tryAgain(row.id)}>
						<Icon name="retry" /> Try again
					</button>
				{/if}
			</span>
		</li>
	{/each}
</ul>

<style>
	.pending {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
		gap: 0.75rem;
	}
	.item {
		display: flex;
		gap: 0.9rem;
		padding: 0.75rem;
		align-items: flex-start;
	}
	.thumb {
		flex: none;
		display: grid;
		place-items: center;
		width: 4.5rem;
		height: 4.5rem;
		border-radius: var(--radius-small);
		background: var(--tile-bg);
		color: var(--muted);
		overflow: hidden;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}
	.name {
		font-size: var(--fs-small);
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.line {
		font-weight: 700;
	}
	.line.ok {
		color: var(--ok);
	}
	.line.error,
	.line.retry {
		color: var(--danger);
	}
	.detail {
		font-size: var(--fs-small);
		color: var(--muted);
	}
	.spinner {
		margin-right: 0.35rem;
	}
</style>
