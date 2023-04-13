import { JSDOM } from "jsdom";
const domParser = new new JSDOM().window.DOMParser();
const parseDom = domParser.parseFromString.bind(domParser);
const mapOpt = <S, T>(v: S | undefined, f: (v: S) => T | undefined): T | undefined =>
  v === undefined ? undefined : f(v);

const ROOT_URL = "https://www.iaeste.cz";
const BASE_URL = ROOT_URL + "/student-report?page=student_report_list";
const SUBLIST_URL = ROOT_URL + "/student-report?page=student_report_country";
const REVIEW_URL = ROOT_URL + "/student-report?page=student_report&id=";

const LANG_URL_FRAGMENT = "&lang=";
const UI_LANG_URL_FRAGMENT = "&ui_lang=";
const LANG_CZECH = "cs_cz";
const LANG_ENGLISH = "en_us";

const COUNTRY_URL_FRAGMENT = "&country=";
const COUNTRY_URL_FRAGMENT_REGEX = /&country=(\d+)/;
const FIELD_URL_FRAGMENT = "&faculty=";
const FIELD_URL_FRAGMENT_REGEX = /&faculty=(\d+)/;
const SPECIALIZATION_URL_FRAGMENT = "&specialization=";
const SPECIALIZATION_URL_FRAGMENT_REGEX = /&specialization=(\d+)/;
const REVIEW_ID_URL_FRAGMENT = "&id=";
const REVIEW_ID_URL_FRAGMENT_REGEX = /&id=(\d+)/;

const REVIEW_IN_CZECH_ICON = "i-cz.png";

async function urlToDocument(url: string): Promise<Document> {
  const text = await (await fetch(url)).text();
  return parseDom(text, "text/html");
}
const isAnchor = (el: Element | null): el is HTMLAnchorElement => el?.matches("a") ?? false;
const textOf = (el: Element | null): string => el?.textContent?.trim() ?? "";

export interface LocalizedString {
  cs: string;
  en: string;
}
export interface Country {
  id: number;
  name: LocalizedString;
}
export interface CountryCategory {
  name: LocalizedString;
  countries: Country[];
}
export interface Field {
  id: number;
  name: LocalizedString;
}
export interface Categories {
  countryCategories: CountryCategory[];
  fields: Field[];
}
async function getBaseTableCells(lang: string) {
  const doc = await urlToDocument(BASE_URL + LANG_URL_FRAGMENT + lang);
  const table = doc.querySelector(".content .tablediv table");
  return [...(table?.querySelectorAll("td") ?? [])];
}
export async function getBaseCategories(): Promise<Categories> {
  const enCells = await getBaseTableCells(LANG_ENGLISH);
  const csCells = await getBaseTableCells(LANG_CZECH);

  // extract countries in english
  type Cat = { en: string; cs?: string; countries: Array<{ id: number; en: string; cs?: string }> };
  const cats: Cat[] = [];
  for (const cell of enCells) {
    let cat: Cat | undefined;
    for (const el of cell.children) {
      if (el.matches("h2")) {
        cat = { en: textOf(el), countries: [] };
        cats.push(cat);
      }

      if (!cat || !isAnchor(el)) continue;

      const id = Number(el.href.match(COUNTRY_URL_FRAGMENT_REGEX)?.[1] ?? -1);
      if (id !== -1) cat.countries.push({ en: textOf(el), id });
    }
  }

  // extract countries in czech
  const csHeadings = csCells.flatMap((c) => [...c.querySelectorAll("h2")]);
  for (const [i, heading] of csHeadings.entries()) cats[i].cs = textOf(heading);

  const csAnchors = csCells.flatMap((c) => [...c.querySelectorAll("a")]);
  const countriesById = new Map(cats.flatMap(({ countries }) => countries).map((c) => [c.id, c]));
  csAnchors
    .map((a) => ({ cs: textOf(a), id: Number(a.href.match(COUNTRY_URL_FRAGMENT_REGEX)?.[1] ?? -1) }))
    .filter(({ id }) => id !== -1)
    .map(({ cs, id }) => ({ cs, country: countriesById.get(id) }))
    .forEach(({ country, cs }) => {
      if (country) country.cs = cs;
    });

  // collect all country categories
  const countryCategories: CountryCategory[] = cats.map(({ en, cs, countries }) => ({
    name: { en, cs: cs ?? "" },
    countries: countries.map(({ id, en, cs }) => ({
      id,
      name: { en, cs: cs ?? "" },
    })),
  }));

  // extract fields
  const enAnchors = enCells.flatMap((c) => [...c.querySelectorAll("a")]);
  const enFields = new Map(
    enAnchors.map((a) => [Number(a.href.match(FIELD_URL_FRAGMENT_REGEX)?.[1] ?? -1), textOf(a)])
  );
  const csFields = new Map(
    csAnchors.map((a) => [Number(a.href.match(FIELD_URL_FRAGMENT_REGEX)?.[1] ?? -1), textOf(a)])
  );
  enFields.delete(-1);
  csFields.delete(-1);

  // collect all fields
  const fields: Field[] = [...enFields.keys()].map((id) => ({
    id,
    name: { en: enFields.get(id) ?? "", cs: csFields.get(id) ?? "" },
  }));

  return {
    countryCategories,
    fields,
  };
}

export interface ReviewEntry {
  id: number;
  year: number;
  location: string;
  reviewLanguage: "cs" | "en";
  student: { name: string; surname: string };
  university?: LocalizedString;
  thumbnailUrl?: string;
}
export function getReviewEntriesByCountry(countryId: number) {
  return sublistToReviewEntries(SUBLIST_URL + COUNTRY_URL_FRAGMENT + countryId);
}
export function getReviewEntriesByField(fieldId: number) {
  return sublistToReviewEntries(SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId);
}
export function getReviewEntriesBySpecialization(fieldId: number, specializationId: number) {
  return sublistToReviewEntries(
    SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId + SPECIALIZATION_URL_FRAGMENT + specializationId
  );
}
async function sublistToReviewEntries(url: string): Promise<ReviewEntry[]> {
  const enDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_ENGLISH);
  const csDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_CZECH);

  const [enRows, csRows] = [enDoc, csDoc].map((doc) => [
    ...(doc.querySelector(".content .tablist table tbody")?.querySelectorAll("tr") ?? []),
  ]);

  csRows.shift();
  const headers = [...(enRows.shift()?.querySelectorAll("td, th") ?? [])].map((th) => textOf(th).toLowerCase());

  const findColumn = (str: string) => headers.findIndex((h) => h.includes(str)) + 1;
  const cols = {
    year: findColumn("year"),
    location: findColumn("location"),
    student: findColumn("student"),
    university: findColumn("university"),
    specialization: findColumn("specialization"),
  };

  const getColumn = (tr: Element, i: number) => tr.querySelector(`td:nth-of-type(${i})`);
  return enRows.map((row, i): ReviewEntry => {
    const a = getColumn(row, cols.location)?.querySelector("a");
    const id = Number(a?.href.match(REVIEW_ID_URL_FRAGMENT_REGEX)?.[1] ?? -1);

    const year = Number(textOf(getColumn(row, cols.year)));
    const location = textOf(getColumn(row, cols.location));
    const student = textOf(getColumn(row, cols.student))
      .split(",")
      .map((s) => s.trim());
    const [surname, name] = student;

    const reviewLanguage = row.querySelector(`img[src*="${REVIEW_IN_CZECH_ICON}"]`) === null ? "en" : "cs";
    const universityEn = textOf(getColumn(row, cols.university));
    const universityCs =
      mapOpt(
        csRows.find((row) => [...row.querySelectorAll("a")].some((a) => a.href.match(REVIEW_ID_URL_FRAGMENT + id))),
        (row) => textOf(getColumn(row, cols.university))
      ) ?? "";
    const university =
      universityEn === "" && universityCs === ""
        ? undefined
        : {
            en: universityEn,
            cs: universityCs,
          };

    const thumbnailUrl = mapOpt(row.querySelector<HTMLImageElement>("img.thumb_img")?.src, (src) => ROOT_URL + src);

    return {
      id,
      year,
      location,
      student: { name, surname },
      reviewLanguage,
      university,
      thumbnailUrl,
    };
  });
}
