<!-- Links between the admin pages, and the way back to being a family member. Not printed. -->
<script lang="ts">
	import { page } from '$app/state';
	import Icon from '../Icon.svelte';
	import AdminIcon from './AdminIcon.svelte';

	const current = (href: string) => (page.url.pathname === href ? 'page' : undefined);
</script>

<nav class="admin-nav" aria-label="Admin pages">
	<a class="link" href="/admin" aria-current={current('/admin')}><Icon name="shield" /> Overview</a>
	<a class="link" href="/admin/trash" aria-current={current('/admin/trash')}><Icon name="trash" /> Trash</a>
	<a class="link" href="/admin/qr" aria-current={current('/admin/qr')}><AdminIcon name="qr" /> QR cards</a>
	<form method="POST" action="/admin/logout">
		<button type="submit" class="btn btn-quiet"><Icon name="arrow-left" /> Leave admin mode</button>
	</form>
</nav>

<style>
	.admin-nav {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 1.25rem;
		margin-bottom: 1rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--line);
	}
	.link {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: var(--tap);
		font-weight: 600;
	}
	.link[aria-current='page'] {
		color: var(--text);
		text-decoration: none;
	}
	form {
		margin-left: auto;
	}
	@media print {
		.admin-nav {
			display: none;
		}
	}
</style>
