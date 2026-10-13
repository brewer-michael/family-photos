<!-- Minimal name page; the UI track restyles it. -->
<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1>What should we call you?</h1>
<p>Your first name is fine — for example "Grandma Jo" or "Uncle Bob". Everyone will see it next to the photos you add.</p>

<form method="POST">
	<input type="hidden" name="next" value={data.next} />
	<label for="name">Your name</label>
	<input
		id="name"
		name="name"
		type="text"
		autocomplete="given-name"
		autocapitalize="words"
		maxlength="40"
		value={data.currentName ?? ''}
		aria-describedby={form?.message ? 'name-error' : undefined}
	/>
	{#if form?.message}
		<p id="name-error" role="alert">{form.message}</p>
	{/if}
	<button type="submit">Continue</button>
</form>
