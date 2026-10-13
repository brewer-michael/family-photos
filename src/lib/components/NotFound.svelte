<!-- Friendly error page body (used by the +error pages of albums and the viewer). -->
<script lang="ts">
	import Icon from './Icon.svelte';

	interface Props {
		status: number;
		message?: string;
		backHref?: string;
		backLabel?: string;
	}

	let { status, message, backHref = '/', backLabel = 'Go to all albums' }: Props = $props();
	const notFound = $derived(status === 404);
</script>

<div class="page page-narrow not-found">
	<h1>{notFound ? "We couldn't find that" : 'Something went wrong'}</h1>
	<p>
		{#if notFound}
			{message ?? "It may have been moved or removed, or it isn't ready yet."}
		{:else}
			Sorry about that. Please try again in a moment.
		{/if}
	</p>
	<a class="btn btn-primary btn-big" href={backHref}><Icon name="home" /> {backLabel}</a>
</div>

<style>
	.not-found {
		text-align: center;
		padding-top: 3rem;
	}
</style>
