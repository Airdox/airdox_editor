/** Shared types for the non-destructive stem-separation pipeline. */
export type StemId = 'vocals' | 'drums' | 'bass' | 'other' | 'synth' | 'percussion' | 'fx' | (string & {});

export type StemProfile = 'PREVIEW' | 'HIGH_QUALITY';

export interface StemDescriptor {
  id: StemId;
  label?: string;
  order?: number;
}

export interface BackendCapabilities {
  trainedModel: boolean;
  supportsCancellation?: boolean;
  supportsStereo?: boolean;
  stemOrder: StemId[];
  [key: string]: unknown;
}
