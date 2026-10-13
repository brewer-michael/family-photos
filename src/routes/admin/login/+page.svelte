<!-- Admin sign-in. Works without JavaScript (a plain form POST); rate-limited on the server. -->
<script lang="ts">
	import type { PageProps } from './$types';
	import Icon from '#lib/components/Icon.svelte';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Admin sign-in · {data.siteTitle}</title>
</svelte:head>

<div class="page page-narrow">
	<h1><Icon name="shield" /> Admin sign-in</h1>
	<p class="muted">Only for {data.adminName}: removal requests, the trash, QR cards and settings.</p>

	<form method="POST" class="card">
		<input type="hidden" name="next" value={data.next} />
		<div class="field">
			<label for="password">Admin password</label>
			<input
				id="password"
				class="input"
				name="password"
				type="password"
				autocomplete="current-password"
				required
				aria-invalid={!!form?.message}
				aria-describedby={form?.message ? 'password-error' : undefined}
			/>
			{#if form?.message}
				<p id="password-error" role="alert" class="error">{form.message}</p>
			{/if}
		</div>
		<button type="submit" class="btn btn-primary btn-block"><Icon name="arrow-right" /> Sign in</button>
	</form>

	<p class="back"><a href="/"><Icon name="arrow-left" /> Back to the photos</a></p>
</div>

<style>
	h1 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	form {
		padding: 1.25rem;
		margin-top: 1.5rem;
	}
	.back a {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: var(--tap);
		margin-top: 1rem;
		font-weight: 600;
	}
</style>
