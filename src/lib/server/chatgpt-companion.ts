export type CompanionConfig = {
	pairingId: string;
	pairingKey: string;
	nonce: string;
	origin: string;
	expiresAt: number;
	clientId: string;
	newRegistration: boolean;
	loginHint?: string;
	reconsent: boolean;
};
