<script lang="ts">
	import { ArrowRight, Copy, Plus } from '@lucide/svelte';

	export type HouseholdMember = { id: string; name: string; email: string; role: string };
	export type HouseholdInvite = { inviteId: string; expiresAt: number };

	let {
		mode,
		userId,
		members,
		householdInvites,
		canManageHousehold,
		householdBusy,
		busy,
		inviteCode,
		joinCode = $bindable(''),
		error,
		memberToRemove,
		oninvite,
		onrevoke,
		onaskremove,
		oncancelremove,
		onconfirmremove,
		onjoin,
		onaskleave,
		onconfirmleave,
		onnotify
	}: {
		mode: 'household' | 'removeMember' | 'leave';
		userId?: string;
		members: HouseholdMember[];
		householdInvites: HouseholdInvite[];
		canManageHousehold: boolean;
		householdBusy: boolean;
		busy: boolean;
		inviteCode: string;
		joinCode: string;
		error: string;
		memberToRemove: HouseholdMember | null;
		oninvite: () => void;
		onrevoke: (inviteId: string) => void;
		onaskremove: (member: HouseholdMember) => void;
		oncancelremove: () => void;
		onconfirmremove: () => void;
		onjoin: () => void;
		onaskleave: () => void;
		onconfirmleave: () => void;
		onnotify: (message: string) => void;
	} = $props();
</script>

{#if mode === 'household'}
	<span class="dialog-spark">✳</span>
	<h2>Your household</h2>
	<p class="muted">Shared pantry, recipes, meals, and shopping.</p>
	{#if householdBusy}<p class="field-help" role="status">Updating household…</p>{/if}
	<div class="household-members">
		{#each members as member (member.id)}
			<div class="member-row">
				<span class="profile-avatar">{member.name.trim().charAt(0).toUpperCase() || '•'}</span>
				<div class="member-copy">
					<b>{member.name}{member.id === userId ? ' · You' : ''}</b>
					<span>{member.email}</span>
				</div>
				<span class="member-role" class:owner-role={member.role === 'owner'}
					>{member.role === 'owner' ? 'Owner' : 'Member'}</span
				>
				{#if canManageHousehold && member.role !== 'owner' && member.id !== userId}
					<button
						class="text-button danger member-remove"
						disabled={householdBusy}
						onclick={() => onaskremove(member)}>Remove</button
					>
				{/if}
			</div>
		{/each}
	</div>
	{#if canManageHousehold}
		<section class="household-invites">
			<h3>Invitations</h3>
			{#if householdInvites.length}
				<div class="invite-list">
					{#each householdInvites as invite (invite.inviteId)}
						<div class="invite-row">
							<span
								>Expires {new Date(invite.expiresAt).toLocaleDateString('en', {
									month: 'short',
									day: 'numeric'
								})}</span
							>
							<button
								class="text-button danger"
								disabled={householdBusy}
								onclick={() => onrevoke(invite.inviteId)}>Revoke</button
							>
						</div>
					{/each}
				</div>
			{:else}
				<p class="field-help">No active invitations.</p>
			{/if}
			<button class="primary full" disabled={householdBusy} onclick={oninvite}
				><Plus size={17} /> Create invitation</button
			>
			{#if inviteCode}
				<div class="invite-code">
					<code>{inviteCode}</code>
					<button
						class="icon-button"
						aria-label="Copy invitation"
						onclick={() =>
							navigator.clipboard
								.writeText(inviteCode)
								.then(() => onnotify('Invite code copied.'))
								.catch(() => onnotify('Select and copy the code manually.'))}
						><Copy size={17} /></button
					>
				</div>
				<p class="field-help">Share privately. This code works once.</p>
			{/if}
		</section>
	{:else}
		<p class="field-help">Only the household owner can manage invitations or remove members.</p>
	{/if}
	<hr />
	<h3>Have an invitation?</h3>
	<label class="field"
		>Invite code<input
			bind:value={joinCode}
			placeholder="Paste invitation code"
			autocomplete="off"
		/></label
	>
	<button class="secondary full" disabled={householdBusy || !joinCode.trim()} onclick={onjoin}
		>Join household <ArrowRight size={17} /></button
	>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<button class="text-button danger full" disabled={householdBusy} onclick={onaskleave}
		>Leave this household</button
	>
{:else if mode === 'removeMember'}
	<h2>Remove household member?</h2>
	<p class="muted">
		{memberToRemove?.name} will lose access to this shared kitchen. Their account will remain active.
	</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="dialog-actions">
		<button class="secondary" disabled={householdBusy} onclick={oncancelremove}>Keep member</button>
		<button class="primary danger-action" disabled={householdBusy} onclick={onconfirmremove}
			>{householdBusy ? 'Removing…' : 'Remove member'}</button
		>
	</div>
{:else}
	<h2>Leave this household?</h2>
	<p class="muted">
		Leaving gives you a new personal kitchen. The shared pantry and recipes stay with your
		household. You can rejoin with a new invitation.
	</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<button class="primary full" onclick={onconfirmleave} disabled={busy}>Leave household</button>
{/if}

<style>
	.danger-action {
		background: #a43f36;
		color: white;
	}
	.dialog-actions .danger-action:hover {
		background: #87332c;
	}
	.household-members {
		margin-top: 10px;
	}
	.household-members .member-row {
		gap: 9px;
		flex-wrap: wrap;
		padding: 12px 0;
	}
	.member-copy {
		min-width: 0;
		flex: 1 1 125px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.member-copy span {
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.member-role {
		padding: 4px 7px;
		background: var(--wash);
		color: var(--muted);
		font-size: 12px;
	}
	.member-role.owner-role {
		background: var(--accent);
		color: var(--ink);
	}
	.member-remove {
		min-height: 40px;
		padding-inline: 6px;
		font-size: 13px;
	}
	.household-invites {
		margin-top: 22px;
		padding: 18px 0 4px;
		border-top: 1px solid var(--line);
	}
	.household-invites h3 {
		margin-bottom: 6px;
	}
	.invite-list {
		margin: 8px 0 14px;
	}
	.invite-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 44px;
		border-bottom: 1px solid var(--line);
		font-size: 14px;
	}
	.invite-row button {
		min-height: 40px;
		padding-inline: 6px;
	}
</style>
