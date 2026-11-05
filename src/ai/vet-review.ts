/** The reviewer's vet-review.json. Task 7 adds the validator. */
export interface VetReview {
  relevance: 'high' | 'medium' | 'low' | 'none';
  why: string;
  overlaps: { id: string; how: string }[];
  injection: { file: string; line: number; verdict: 'benign' | 'suspicious'; why: string }[];
  recommendation: 'install' | 'install-with-care' | 'skip';
  summary: string;
}
