<!--
	Family code page. Works without JavaScript (a plain form POST). A wrong code comes back in the
	field, with the field focused, so "Check the spelling" means fixing one letter, not retyping.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';
	import Icon from '#lib/components/Icon.svelte';

	let { data, form }: PageProps = $props();
	const describedBy = $derived(form?.message ? 'code-hint code-error' : 'code-hint');
	let codeInput = $state<HTMLInputElement>();

	onMount(() => {
		if (form?.message && codeInput) {
			codeInput.focus();
			codeInput.setSelectionRange(codeInput.value.length, codeInput.value.length);
		}
	});
</script>

<svelte:head>
	<title>Welcome · {data.siteTitle}</title>
</svelte:head>

<div class="page page-narrow welcome">
	<img class="logo" src="/icons/icon-192.png" alt="" width="96" height="96" />
	<h1>Welcome to {data.siteTitle}</h1>
	<p class="lead">Our family's photos and videos, all in one place.</p>

	{#if data.joinExpired}
		<p class="notice" role="alert">
			That QR code doesn't work any more. Type the family code instead, or ask {data.adminName} for a new one.
		</p>
	{/if}

	<form method="POST" class="card">
		<input type="hidden" name="next" value={data.next} />
		<div class="field">
			<label for="code">Family code</label>
			<p id="code-hint" class="hint">The words the family shared with you. Capitals and spaces don't matter.</p>
			<input
				id="code"
				class="input code"
				name="code"
				type="text"
				autocapitalize="off"
				autocomplete="off"
				autocorrect="off"
				spellcheck="false"
				enterkeyhint="go"
				required
				defaultValue={form && 'code' in form ? form.code : ''}
				bind:this={codeInput}
				aria-invalid={!!form?.message}
				aria-describedby={describedBy}
			/>
			{#if form?.message}
				<p id="code-error" role="alert" class="error" class:limited={form.limited}>{form.message}</p>
			{/if}
		</div>
		<button type="submit" class="btn btn-primary btn-big btn-block"><Icon name="arrow-right" /> Come in</button>
	</form>

	<p class="muted ask">Don't know the code? Ask {data.adminName}.</p>
</div>

<style>
	.welcome {
		text-align: center;
		padding-top: 2rem;
	}
	.logo {
		border-radius: 22px;
		margin-bottom: 1rem;
	}
	.lead {
		font-size: var(--fs-large);
		color: var(--muted);
	}
	form {
		text-align: left;
		padding: 1.25rem;
		margin-top: 1.5rem;
	}
	.code {
		font-size: var(--fs-large);
		min-height: calc(var(--tap) * 1.15);
	}
	.ask {
		margin-top: 1.5rem;
	}
</style>
