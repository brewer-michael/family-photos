<!--
	"What should we call you?" — asked once per device. Works without JavaScript.
	"Not Jo?" leads here too, usually because someone else has the phone, so the field starts empty
	(no one has to delete Jo's name first) and Jo has a way back. Typing a different name makes a new
	device id (+page.server.ts); typing the same name again keeps Jo's.
	No `value`: on a slow phone someone may start typing before the page hydrates, and hydrating a
	`value` would wipe what they typed.
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
				aria-invalid={!!form?.message}
				aria-describedby={describedBy}
			/>
			{#if form?.message}
				<p id="name-error" role="alert" class="error">{form.message}</p>
			{/if}
		</div>
		<button type="submit" class="btn btn-primary btn-big btn-block"><Icon name="check" /> Continue</button>
	</form>

	{#if data.currentName}
		<p class="still">
			<a class="btn btn-quiet" href={data.next}><Icon name="arrow-left" /> Go back, I'm {data.currentName}</a>
		</p>
	{/if}
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
	.still {
		margin-top: 1rem;
	}
	.still .btn {
		padding-inline: 0;
	}
</style>
