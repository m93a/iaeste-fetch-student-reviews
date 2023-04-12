import { JSDOM } from "jsdom";
const domParser = new new JSDOM().window.DOMParser();
const parseDom = domParser.parseFromString.bind(domParser);

const BASE_URL = "https://www.iaeste.cz/student-report?page=student_report_list";
const LANG_URL_FRAGMENT = "&lang=";
const UI_LANG_URL_FRAGMENT = "&ui_lang=";
const LANG_CZECH = "cs_cz";
const LANG_ENGLISH = "en_us";

const COUNTRY_URL_FRAGMENT = "&country=";
const COUNTRY_URL_FRAGMENT_REGEX = /&country=(\d+)/;
const FIELD_URL_FRAGMENT = "&faculty=";
const FIELD_URL_FRAGMENT_REGEX = /&faculty=(\d+)/;
const SPECIALIZATION_URL_FRAGMENT = "&specialization=";

const REVIEW_URL = "https://www.iaeste.cz/student-report?page=student_report&id=";

async function urlToDocument(url: string): Promise<Document> {
  const text = await (await fetch(url)).text();
  return parseDom(text, "text/html");
}
const isAnchor = (el: Element): el is HTMLAnchorElement => el.matches("a");
const textOf = (el: Element): string => el.textContent?.trim() ?? '';

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
  const enFields = new Map(enAnchors.map((a) => [Number(a.href.match(FIELD_URL_FRAGMENT_REGEX)?.[1] ?? -1), textOf(a)]));
  const csFields = new Map(csAnchors.map((a) => [Number(a.href.match(FIELD_URL_FRAGMENT_REGEX)?.[1] ?? -1), textOf(a)]));
  enFields.delete(-1);
  csFields.delete(-1);

  // collect all fields
  const fields: Field[] = [...enFields.keys()].map((id) => ({ id, name: { en: enFields.get(id) ?? "", cs: csFields.get(id) ?? "" } }));

  return {
    countryCategories,
    fields,
  };
}
