<!-- Square tiles linking to the viewer: 3 across on phones, more on bigger screens. -->
<script lang="ts">
	import Icon from './Icon.svelte';
	import type { TileDTO } from '#lib/client/dto';
	import { formatDuration, tileAlt } from '#lib/client/format';

	interface Props {
		items: TileDTO[];
		timeZone: string;
		/** Accessible name of the list, e.g. "Photos and videos in Retreat 2023". */
		label: string;
		/** Horizontal strip (home page "New photos") instead of a grid. */
		strip?: boolean;
	}

	let { items, timeZone, label, strip = false }: Props = $props();
</script>

<ul class="tile-grid" class:strip aria-label={label}>
	{#each items as item (item.id)}
		<li class="tile">
			<a href="/view/{item.id}">
				<img src={item.thumbUrl} alt={tileAlt(item, timeZone)} width="480" height="480" loading="lazy" decoding="async" />
				{#if item.kind === 'video'}
					<span class="badge" aria-hidden="true">
						<Icon name="play" size="1em" />
						{formatDuration(item.durationMs)}
					</span>
				{/if}
			</a>
		</li>
	{/each}
</ul>

<style>
	.tile-grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 4px;
	}
	@media (min-width: 40rem) {
		.tile-grid {
			grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
			gap: 6px;
		}
	}
	.tile-grid.strip {
		display: flex;
		overflow-x: auto;
		scroll-snap-type: x proximity;
		padding-bottom: 0.5rem;
		gap: 6px;
	}
	.strip .tile {
		flex: 0 0 auto;
		width: clamp(7rem, 30vw, 10rem);
		scroll-snap-align: start;
	}
	.tile {
		position: relative;
		aspect-ratio: 1;
		background: var(--tile-bg);
		border-radius: 6px;
		overflow: hidden;
	}
	.tile a {
		display: block;
		width: 100%;
		height: 100%;
		border-radius: inherit;
	}
	.tile a:focus-visible {
		outline-offset: -4px;
		box-shadow: inset 0 0 0 7px var(--focus-halo);
	}
	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		/* The alt text shows (and wraps) if a thumbnail is missing. */
		color: var(--muted);
		font-size: var(--fs-small);
	}
	.badge {
		position: absolute;
		left: 6px;
		bottom: 6px;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		background: rgb(0 0 0 / 0.72);
		color: #fff;
		font-size: var(--fs-small);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
</style>
