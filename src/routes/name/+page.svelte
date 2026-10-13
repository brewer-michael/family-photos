<!--
	"What should we call you?" — asked once per device. Works without JavaScript.
	defaultValue, not value: on a slow phone someone may start typing before the page hydrates, and
	hydrating a `value` would wipe what they typed.
-->
<script lang="ts">
	import type { PageProps } from './$types';
	import Icon from '#lib/components/Icon.svelte';

	let { data, form }: PageProps = $props();
	const describedBy = $derived(form?.message ? 'name-hint name-error' : 'name-hint');
</script>

<svelte:head>
	<title>Your name · {data.siteTitle}</title>
</svelte:head>

<div class="page page-narrow">
	<h1>What should we call you?</h1>
	<p id="name-hint" class="lead">
		Your first name is fine — for example "Grandma Jo" or "Uncle Bob". Everyone will see it next to the
		photos you add.
	</p>

	<form method="POST" class="card">
		<input type="hidden" name="next" value={data.next} />
		<div class="field">
			<label for="name">Your name</label>
			<input
				id="name"
				class="input name"
				name="name"
				type="text"
				autocomplete="given-name"
				autocapitalize="words"
				enterkeyhint="done"
				maxlength="40"
				required
				defaultValue={data.currentName ?? ''}
				aria-invalid={!!form?.message}
				aria-describedby={describedBy}
			/>
			{#if form?.message}
				<p id="name-error" role="alert" class="error">{form.message}</p>
			{/if}
		</div>
		<button type="submit" class="btn btn-primary btn-big btn-block"><Icon name="check" /> Continue</button>
	</form>
</div>

<style>
	.page {
		padding-top: 2rem;
	}
	.lead {
		font-size: var(--fs-large);
	}
	form {
		padding: 1.25rem;
		margin-top: 1rem;
	}
	.name {
		font-size: var(--fs-large);
		min-height: calc(var(--tap) * 1.15);
	}
</style>
