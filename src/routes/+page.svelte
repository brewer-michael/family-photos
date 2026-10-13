<script lang="ts">
	import type { PageProps } from './$types';
	import AlbumCard from '#lib/components/AlbumCard.svelte';
	import HomeScreenTip from '#lib/components/HomeScreenTip.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import MediaGrid from '#lib/components/MediaGrid.svelte';

	let { data }: PageProps = $props();
</script>

<div class="page">
	<h1 class="greeting">Hi {data.name}!</h1>

	<a class="btn btn-primary btn-big add" href="/add"><Icon name="plus" /> Add photos &amp; videos</a>

	<section class="section" aria-labelledby="new-title">
		<h2 id="new-title">New photos</h2>
		{#if data.recent.length > 0}
			<MediaGrid items={data.recent} timeZone={data.timeZone} label="The newest photos and videos" strip />
		{:else}
			<div class="empty">
				<p>No photos yet. Be the first to add some!</p>
			</div>
		{/if}
	</section>

	<section class="section" aria-labelledby="albums-title">
		<h2 id="albums-title">Albums</h2>
		<ul class="albums">
			{#each data.albums as album (album.id)}
				<li><AlbumCard {album} /></li>
			{/each}
			<li>
				<a class="new-album card" href="/album/new">
					<Icon name="plus" size="2.5em" />
					<span>New album</span>
				</a>
			</li>
		</ul>
	</section>

	<HomeScreenTip siteTitle={data.siteTitle} />
</div>

<style>
	.greeting {
		margin-top: 0.5rem;
	}
	.add {
		width: 100%;
		max-width: 28rem;
		margin-top: 0.5rem;
	}
	.albums {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
		gap: 1rem;
	}
	@media (max-width: 30rem) {
		.albums {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.75rem;
		}
	}
	.new-album {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		height: 100%;
		min-height: 10rem;
		border: 3px dashed var(--border);
		box-shadow: none;
		background: transparent;
		color: var(--primary);
		font-size: var(--fs-large);
		font-weight: 700;
		text-decoration: none;
	}
</style>
