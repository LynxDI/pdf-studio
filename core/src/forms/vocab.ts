// Canonical record vocabulary — the shared, dotted key paths a person/record can
// hold. Form packs bind their fields to these (`from: "<role>.<key>"`), so the same
// record fills passport, tax, insurance, … forms. This is guidance + validation, not
// a hard limit: a record may hold extra keys, and domain packs (insurance, employment)
// extend the set. blankPeople() emits a starter household from it.

export interface VocabEntry {
  label: string;
  example?: string;
}

/** Canonical record keys, by dotted path. */
export const VOCAB: Record<string, VocabEntry> = {
  first_name: { label: "First name", example: "Jordan" },
  middle_name: { label: "Middle name / initial", example: "A" },
  last_name: { label: "Last name", example: "Sample" },
  full_name: { label: "Full name", example: "Jordan A Sample" },
  ssn: { label: "Social Security Number", example: "123-45-6789" },
  itin: { label: "ITIN", example: "" },
  ein: { label: "Employer Identification Number", example: "12-3456789" },
  date_of_birth: { label: "Date of birth (YYYY-MM-DD)", example: "1990-05-14" },
  gender: { label: "Sex (Male/Female)", example: "Female" },
  place_of_birth: { label: "Place of birth", example: "Seattle, WA, USA" },
  us_citizen: { label: "U.S. citizen (Yes/No)", example: "Yes" },
  citizenship_country: { label: "Country of citizenship", example: "USA" },
  relationship: { label: "Relationship (e.g. to the applicant)", example: "Son" },
  marital_status: { label: "Marital status", example: "Single" },
  email: { label: "Email", example: "jordan@example.com" },
  phone_home: { label: "Home phone", example: "425-555-0100" },
  phone_work: { label: "Work phone", example: "" },
  phone_cell: { label: "Cell phone", example: "" },
  "address.street": { label: "Street address", example: "123 Main St" },
  "address.line2": { label: "Address line 2", example: "" },
  "address.apt": { label: "Apartment / unit", example: "" },
  "address.city": { label: "City", example: "Bellevue" },
  "address.state": { label: "State", example: "WA" },
  "address.zip": { label: "ZIP code", example: "98005" },
  "address.country": { label: "Country", example: "USA" },
  occupation: { label: "Occupation", example: "Engineer" },
  employer: { label: "Employer or school", example: "Acme Corp" },
  height: { label: "Height", example: "5'10\"" },
  hair_color: { label: "Hair color", example: "Brown" },
  eye_color: { label: "Eye color", example: "Brown" },
  "emergency_contact.name": { label: "Emergency contact name", example: "Bob Sample" },
  "emergency_contact.phone": { label: "Emergency contact phone", example: "425-555-0101" },
  "emergency_contact.relationship": { label: "Emergency contact relationship", example: "Spouse" },
};

/** Relations that connect records into roles (household). */
export const RELATIONS = ["spouse", "parents", "dependents"] as const;

/** True if a dotted record-key path is a recognized canonical key (address.* etc. allowed). */
export function isVocabKey(path: string): boolean {
  if (path in VOCAB) return true;
  // allow any nested key under a known namespace (address.*, emergency_contact.*)
  const ns = path.split(".")[0] ?? "";
  return ["address", "emergency_contact"].includes(ns);
}

/** A starter people.yaml household (mock data) for the buildProfile / form_people flows. */
export function blankPeople(): string {
  return [
    "# people.yaml — your local, PRIVATE records store (shared across all forms).",
    "# KEEP THIS FILE LOCAL. It holds PII (SSN, DOB, address); it is auto-gitignored.",
    "# Each entry under `people:` is one person, referenced by id. `relations` links",
    "# people so a form can pull a spouse/parents/dependents. Fill in real values.",
    "people:",
    "  me:",
    "    first_name: Jordan",
    "    middle_name: A",
    "    last_name: Sample",
    "    ssn: \"123-45-6789\"",
    "    date_of_birth: \"1990-05-14\"",
    "    gender: Female",
    "    place_of_birth: \"Seattle, WA, USA\"",
    "    us_citizen: Yes",
    "    email: jordan@example.com",
    "    phone_home: \"425-555-0100\"",
    "    occupation: Engineer",
    "    employer: Acme Corp",
    "    address: { street: \"123 Main St\", line2: \"\", apt: \"\", city: Bellevue, state: WA, zip: \"98005\", country: USA }",
    "    emergency_contact: { name: Bob Sample, phone: \"425-555-0101\", relationship: Spouse }",
    "    relations: { spouse: spouse, parents: [parent1, parent2], dependents: [child1] }",
    "  spouse:",
    "    first_name: Bob",
    "    last_name: Sample",
    "    ssn: \"987-65-4321\"",
    "    date_of_birth: \"1989-02-20\"",
    "    gender: Male",
    "    us_citizen: Yes",
    "  parent1:",
    "    first_name: Carol",
    "    last_name: Sample",
    "    date_of_birth: \"1962-07-01\"",
    "    place_of_birth: \"Portland, OR, USA\"",
    "    gender: Female",
    "    us_citizen: Yes",
    "  parent2:",
    "    first_name: David",
    "    last_name: Sample",
    "    date_of_birth: \"1960-11-30\"",
    "    place_of_birth: \"Boise, ID, USA\"",
    "    gender: Male",
    "    us_citizen: Yes",
    "  child1:",
    "    first_name: Alex",
    "    last_name: Sample",
    "    ssn: \"111-22-3333\"",
    "    date_of_birth: \"2015-09-10\"",
    "",
  ].join("\n");
}
