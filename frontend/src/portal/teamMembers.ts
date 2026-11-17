export type TeamMember = {
  name: string;
  alt: string;
  role: string;
  photo?: string;
  projects: string[];
  links: { x?: string; linkedin?: string };
};

export function accountMember(name: string, ranks: string[], projects: string[], photo?: string): TeamMember {
  return { name, alt: name, role: ranks.length ? ranks.join(' · ') : 'Takım üyesi', photo, projects, links: {} };
}

