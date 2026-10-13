<!-- One album on the home page: cover, title, when, how many photos and videos. -->
<script lang="ts">
	import Icon from './Icon.svelte';
	import type { AlbumCardDTO } from '#lib/client/dto';
	import { countLabel } from '#lib/client/format';

	interface Props {
		album: AlbumCardDTO;
		/** Link target; defaults to the album page. */
		href?: string;
	}

	let { album, href }: Props = $props();
</script>

<a class="album-card card" href={href ?? `/album/${album.id}`}>
	<span class="cover">
		{#if album.coverUrl}
			<img src={album.coverUrl} alt="" width="480" height="480" loading="lazy" decoding="async" />
		{:else}
			<Icon name="album" size="2.5em" />
		{/if}
	</span>
	<span class="text">
		<span class="title">{album.title}</span>
		{#if album.whenText}<span class="when">{album.whenText}</span>{/if}
		<span class="count">{countLabel(album.photoCount, album.videoCount)}</span>
	</span>
</a>

<style>
	.album-card {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		color: var(--text);
		text-decoration: none;
	}
	.cover {
		display: grid;
		place-items: center;
		aspect-ratio: 4 / 3;
		background: var(--tile-bg);
		color: var(--muted);
	}
	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.75rem 1rem 1rem;
	}
	.title {
		font-size: var(--fs-large);
		font-weight: 700;
		line-height: 1.25;
	}
	.when,
	.count {
		color: var(--muted);
	}
</style>
