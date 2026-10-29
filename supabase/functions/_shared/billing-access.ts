export interface BillingMembership {
  account_id: string;
  role: string;
  suspended: boolean;
}
export const canReadAccount = (
  platformOwner: boolean,
  member: BillingMembership,
  accountId: string,
) => platformOwner || member.account_id === accountId;
export const canManageAccount = (
  platformOwner: boolean,
  member: BillingMembership,
  accountId: string,
) =>
  platformOwner ||
  (member.account_id === accountId && ["owner", "admin"].includes(member.role));
// AI suspension must never prevent a payer from updating payment details or canceling.
