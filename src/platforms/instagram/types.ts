export interface ProviderInstagramProfile {
  username: string;
  fullName?: string;
  biography?: string;
  isPrivate?: boolean;
  externalUrl?: string;
  posts?: {
    shortCode: string;
    caption?: string;
    timestamp?: string;
  }[];
}
