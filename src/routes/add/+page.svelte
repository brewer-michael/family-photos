<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';
	import Icon from '#lib/components/Icon.svelte';
	import Uploader from '#lib/components/Uploader.svelte';
	import { countLabel } from '#lib/client/format';

	let { data, form }: PageProps = $props();

	/** The album whose batch has finished (shows "Done! See them"). */
	let doneFor = $state<number | null>(null);
</script>

<svelte:head>
	<title>Add photos &amp; videos · {data.siteTitle}</title>
</svelte:head>

<div class="page page-narrow">
	<a class="back" href={data.album ? '/add' : '/'}>
		<Icon name="arrow-left" />
		{data.album ? 'Choose another album' : 'Home'}
	</a>

	{#if data.album}
		<h1>Add photos &amp; videos</h1>
		<p class="to">to <strong>{data.album.title}</strong></p>
		{#key data.album.id}
			<div class="uploader card">
				<Uploader albumId={data.album.id} ondone={() => (doneFor = data.album?.id ?? null)} />
			</div>
		{/key}
		{#if doneFor === data.album.id}
			<a class="btn btn-primary btn-big btn-block done" href="/album/{data.album.id}">
				<Icon name="check" /> Done! See them
			</a>
		{/if}
	{:else}
		<h1>Which album?</h1>
		<p class="muted">Pick where your photos and videos should go.</p>
		<ul class="choices">
			{#each data.albums as album (album.id)}
				<li>
					<a class="choice card" href="/add?album={album.id}">
						<span class="thumb">
							{#if album.coverUrl}
								<img src={album.coverUrl} alt="" width="96" height="96" loading="lazy" />
							{:else}
								<Icon name="album" size="2em" />
							{/if}
						</span>
						<span class="text">
							<span class="title">{album.title}</span>
							<span class="muted">{album.whenText ? `${album.whenText} · ` : ''}{countLabel(album.photoCount, album.videoCount)}</span>
						</span>
						<Icon name="chevron-right" />
					</a>
				</li>
			{/each}
		</ul>

		<section class="section new card" aria-labelledby="new-album-title">
			<h2 id="new-album-title">Or start a new album</h2>
			<form method="POST" action="?/create" use:enhance>
				<div class="field">
					<label for="new-title">Album name</label>
					<input
						id="new-title"
						class="input"
						name="title"
						required
						maxlength="200"
						autocomplete="off"
						defaultValue={form?.title ?? ''}
						aria-invalid={!!form?.error}
						aria-describedby={form?.error ? 'new-title-hint new-title-error' : 'new-title-hint'}
					/>
					<p id="new-title-hint" class="hint">For example "Summer at the lake".</p>
					{#if form?.error}<p id="new-title-error" class="error" role="alert">{form.error}</p>{/if}
				</div>
				<button type="submit" class="btn btn-primary"><Icon name="plus" /> Create album</button>
			</form>
		</section>
	{/if}
</div>

<style>
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: var(--tap);
		font-weight: 600;
	}
	.to {
		font-size: var(--fs-large);
	}
	.uploader {
		padding: 1rem;
	}
	.done {
		margin-top: 1rem;
	}
	.choices {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 1rem;
		min-height: calc(var(--tap) * 1.4);
		padding: 0.6rem 1rem 0.6rem 0.6rem;
		color: var(--text);
		text-decoration: none;
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
	.text {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.title {
		font-size: var(--fs-large);
		font-weight: 700;
	}
	.new {
		padding: 1rem 1.1rem 1.25rem;
	}
</style>
