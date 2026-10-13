<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';
	import Icon from '#lib/components/Icon.svelte';

	let { data, children }: LayoutProps = $props();

	const onNamePage = $derived(page.route.id === '/name');
	const notMeHref = $derived(`/name?next=${encodeURIComponent(page.url.pathname + page.url.search)}`);
</script>

<svelte:head>
	<title>{data.siteTitle}</title>
	<meta name="apple-mobile-web-app-title" content={data.siteTitle} />
</svelte:head>

<a class="skip-link" href="#main">Skip to the main content</a>

<header class="site-header">
	<div class="inner">
		<a class="home" href="/"><Icon name="home" /> <span>{data.siteTitle}</span></a>
		{#if data.role}
			<nav class="you" aria-label="Your account">
				{#if data.role === 'admin'}
					<a class="link" href="/admin"><Icon name="shield" /> Admin</a>
				{/if}
				{#if data.name && !onNamePage}
					<a class="link" href={notMeHref}><span class="wide-only"><Icon name="person" /></span> Not {data.name}?</a>
				{/if}
			</nav>
		{/if}
	</div>
</header>

<main id="main" tabindex="-1">
	{@render children()}
</main>

<style>
	.site-header {
		background: var(--surface);
		border-bottom: 1px solid var(--line);
		padding-top: env(safe-area-inset-top);
	}
	.inner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0 1rem;
		max-width: var(--page-max);
		margin: 0 auto;
		padding: 0 var(--gutter);
	}
	.home,
	.link {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: var(--tap);
		text-decoration: none;
	}
	.home {
		color: var(--text);
		font-size: var(--fs-large);
		font-weight: 800;
	}
	/* Phones: title and "Not Jo?" share one row. */
	@media (max-width: 30rem) {
		.home {
			font-size: var(--fs-base);
		}
		.wide-only {
			display: none;
		}
	}
	.you {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.25rem;
	}
	.link {
		color: var(--primary);
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	/* Only the skip link focuses <main>; it is a landmark, not a control. */
	main:focus {
		outline: none;
		box-shadow: none;
	}
</style>
