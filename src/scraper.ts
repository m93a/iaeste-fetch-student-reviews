import { PromisePool } from "npm:@supercharge/promise-pool@2.4.0";
import { DOMParser, Node, Document, Element } from "https://deno.land/x/deno_dom@v0.1.38/deno-dom-wasm.ts";

const domParser = new DOMParser();
const parseDom = domParser.parseFromString.bind(domParser);

const MAX_CONCURRENT_REQUESTS = 32;
const MAX_CONCURRENT_COUNTRIES = 4;

const ROOT_URL = "https://www.iaeste.cz";
const BASE_URL = ROOT_URL + "/student-report?page=student_report_list";
const SUBLIST_URL = ROOT_URL + "/student-report?page=student_report_country";
const REVIEW_URL = ROOT_URL + "/student-report?page=student_report&id=";

const LANG_URL_FRAGMENT = "&lang=";
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

async function urlToDocument(url: string, cache?: Cache, retries = 5): Promise<Document> {
  const cachedDoc = cache?.get(url);
  if (cachedDoc) return cachedDoc;

  const retry = async () => {
    if (retries <= 0) throw Error(`Failed to fetch URL: ${url}`);
    // wait for 1s, 2s, 3.5s, 10s, 50s before trying again
    // maximum wait time before failing is ~1 min
    await delay(50_000 / retries ** 1.5);
    return urlToDocument(url, cache, retries - 1);
  };

  const response = await fetch(url);
  if (!response.ok) return await retry();

  const text = await response.text();
  const doc = parseDom(text, "text/html");
  if (!doc) return await retry();

  if (cache) cache.set(url, doc);
  return doc;
}

type Cache = Map<string, Document>;
type nullish = null | undefined;
const isElement = (el: unknown): el is Element => el instanceof Element;
const isDocument = (doc: unknown): doc is Document => doc instanceof Document;
const isQueryable = (x: unknown): x is Element | Document => isElement(x) || isDocument(x);
const textOf = (el: Element | nullish): string => el?.textContent?.trim() ?? "";
const hrefOf = (el: Element | nullish): string => el?.getAttribute("href") ?? "";
const srcOf = (el: Element | nullish): string => el?.getAttribute("src") ?? "";
const omit = <T extends Record<any, any>, K extends string & keyof T>(obj: T, ...keys: K[]): Omit<T, K> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !(keys as string[]).includes(k))) as any;
const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const mapOpt = <S, T>(v: S | nullish, f: (v: S) => T | undefined): T | undefined =>
  v === undefined || v === null ? undefined : f(v);
const parse = <S, T extends S>(x: S, validate: (x: S) => x is T): T | undefined => (validate(x) ? x : undefined);
const querySelector = (el: Node | nullish, selector: string): Element | undefined =>
  parse(
    mapOpt(parse(el, isQueryable), (el) => el.querySelector(selector)),
    isElement
  );
const querySelectorAll = (el: Node | nullish, selector: string): Element[] =>
  (mapOpt(parse(el, isQueryable), (el) => [...el.querySelectorAll(selector)]) ?? []).filter(isElement);

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
async function getBaseTableCells(lang: string, cache?: Cache): Promise<Element[]> {
  const doc = await urlToDocument(BASE_URL + LANG_URL_FRAGMENT + lang, cache);
  const table = querySelector(doc, ".content .tablediv table");
  return querySelectorAll(table, "td");
}
export async function getBaseCategories(cache?: Cache): Promise<Categories> {
  const enCells = await getBaseTableCells(LANG_ENGLISH, cache);
  const csCells = await getBaseTableCells(LANG_CZECH, cache);

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

      if (!cat || !isElement(el) || !el.matches("a")) continue;

      const id = Number(hrefOf(el).match(COUNTRY_URL_FRAGMENT_REGEX)?.[1] ?? -1);
      if (id !== -1) cat.countries.push({ en: textOf(el), id });
    }
  }

  // extract countries in czech
  const csHeadings = csCells.flatMap((c) => querySelectorAll(c, "h2"));
  for (const [i, heading] of csHeadings.entries()) cats[i].cs = textOf(heading);

  const csAnchors = csCells.flatMap((c) => querySelectorAll(c, "a"));
  const countriesById = new Map(cats.flatMap(({ countries }) => countries).map((c) => [c.id, c]));
  csAnchors
    .map((a) => ({ cs: textOf(a), id: Number(hrefOf(a)?.match(COUNTRY_URL_FRAGMENT_REGEX)?.[1] ?? -1) }))
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
  const enAnchors = enCells.flatMap((c) => querySelectorAll(c, "a"));
  const enFields = new Map(
    enAnchors.map((a) => [Number(hrefOf(a).match(FIELD_URL_FRAGMENT_REGEX)?.[1] ?? -1), textOf(a)])
  );
  const csFields = new Map(
    csAnchors.map((a) => [Number(hrefOf(a).match(FIELD_URL_FRAGMENT_REGEX)?.[1] ?? -1), textOf(a)])
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

export interface Specialization {
  id: number;
  fieldId: number;
  name: LocalizedString;
}
export async function getSpecializationsOfField(fieldId: number, cache?: Cache): Promise<Specialization[]> {
  const url = SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId;
  const enDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_ENGLISH, cache);
  const csDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_CZECH, cache);

  const [enItems, csItems] = [enDoc, csDoc].map(
    (doc) =>
      new Map(
        querySelectorAll(doc, `a[href*="&faculty=${fieldId}"]`)
          .map((a) => ({
            name: textOf(a),
            id: Number(hrefOf(a).match(SPECIALIZATION_URL_FRAGMENT_REGEX)?.[1] ?? -1),
          }))
          .filter(({ id }) => id !== -1)
          .map(({ id, name }) => [id, name])
      )
  );

  const specs: Specialization[] = [];
  for (const [id, en] of enItems) {
    const cs = csItems.get(id) ?? "";
    specs.push({ id, fieldId, name: { en, cs } });
  }

  return specs;
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
export function getReviewEntriesByCountry(countryId: number, cache?: Cache) {
  return sublistToReviewEntries(SUBLIST_URL + COUNTRY_URL_FRAGMENT + countryId, cache);
}
export function getReviewEntriesByField(fieldId: number, cache?: Cache) {
  return sublistToReviewEntries(SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId, cache);
}
export function getReviewEntriesBySpecialization(fieldId: number, specializationId: number, cache?: Cache) {
  return sublistToReviewEntries(
    SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId + SPECIALIZATION_URL_FRAGMENT + specializationId,
    cache
  );
}
async function sublistToReviewEntries(url: string, cache?: Cache): Promise<ReviewEntry[]> {
  const enDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_ENGLISH, cache);
  const csDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_CZECH, cache);

  const [enRows, csRows] = [enDoc, csDoc].map((doc) =>
    querySelectorAll(querySelector(doc, ".content .tablist table tbody"), "tr")
  );

  csRows.shift();
  const headers = querySelectorAll(enRows.shift(), "td, th").map((th) => textOf(th).toLowerCase());

  const findColumn = (str: string) => headers.findIndex((h) => h.includes(str)) + 1;
  const cols = {
    year: findColumn("year"),
    location: findColumn("location"),
    student: findColumn("student"),
    university: findColumn("university"),
    specialization: findColumn("specialization"),
  };

  const getColumn = (tr: Element, i: number) => tr.querySelector(`td:nth-of-type(${i})`);
  return enRows.map((row): ReviewEntry => {
    const a = querySelector(getColumn(row, cols.location), "a");
    const id = Number(hrefOf(a).match(REVIEW_ID_URL_FRAGMENT_REGEX)?.[1] ?? -1);

    const year = Number(textOf(getColumn(row, cols.year)));
    const location = textOf(getColumn(row, cols.location));
    const student = textOf(getColumn(row, cols.student))
      .split(",")
      .map((s) => s.trim());
    const [surname, name] = student;

    const reviewLanguage = querySelector(row, `img[src*="${REVIEW_IN_CZECH_ICON}"]`) === undefined ? "en" : "cs";
    const universityEn = textOf(getColumn(row, cols.university));
    const universityCs =
      mapOpt(
        csRows.find((row) => querySelectorAll(row, "a").some((a) => hrefOf(a).match(REVIEW_ID_URL_FRAGMENT + id))),
        (row) => textOf(getColumn(row, cols.university))
      ) ?? "";
    const university =
      universityEn === "" && universityCs === ""
        ? undefined
        : {
            en: universityEn,
            cs: universityCs,
          };

    const thumbnailUrl = mapOpt(srcOf(querySelector(row, "img.thumb_img")), (src) => ROOT_URL + src);

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

export interface Photo {
  thumbnailUrl: string;
  fullSizeUrl: string;
}
export interface ReviewContent {
  id: number;
  yearOfStudy: string;
  photos: Photo[];
  fieldName: string;
  specializationName: string;
  info: {
    faculty: string;
    fieldOfStudy: string;
    period: string;
    durationInWeeks: number;
    transport: string;
    insurance: string;
    visa: string;
    visaPrice: string;
    internshipReferenceNumber: string;
  };
  websites: {
    student: string;
    employer: string;
    other: string[];
  };
  place: {
    locationDescription: string;
    aboutCity: string;
    aboutSurroundings: string;
  };
  work: {
    employerDescription: string;
    workDescription: string;
    salaryDescription: string;
    languageRequirements: string;
    accomodation: string;
  };
  socialLife: {
    iaesteMembers: string;
    foreignStudents: string;
    sportAndCulture: string;
    food: string;
  };
  miscellaneous: {
    communicationWithHome: string;
    recommendations: string;
    dontForget: string;
    benefits: string;
    localIaesteCooperation: string;
    overallExperienceWithIaeste: string;
    otherComments: string;
  };
}
export async function getReviewContent(id: number, cache?: Cache): Promise<ReviewContent> {
  const doc = await urlToDocument(REVIEW_URL + id, cache);
  const report = querySelector(doc, ".student_report")!;

  // This here gets the year of study from the report title
  const yearOfStudy = textOf(querySelector(report, "h4")).match(/year (.*)$/i)?.[1] ?? "";

  const photoLinks = querySelectorAll(querySelector(report, ".gallery"), "a");
  const photos = photoLinks.map(
    (a): Photo => ({
      fullSizeUrl: ROOT_URL + hrefOf(a),
      thumbnailUrl: mapOpt(srcOf(querySelector(a, "img")), (s) => ROOT_URL + s) ?? "",
    })
  );

  const infoTable = querySelector(report, "table.header");
  const infoRows = querySelectorAll(infoTable, "tr");
  const infoCells = infoRows.map((row) => querySelectorAll(row, "td").map(textOf) as [string, string]);
  const info = infoCells.map((innerArray) => innerArray[1].trim());

  // it seems all the actual text is in elements with the body class
  const reportBodies = querySelectorAll(querySelector(report, "#report_body"), ".body");
  const bodiesTexts = reportBodies.map((body) => textOf(body));

  return {
    id,
    yearOfStudy,
    photos,
    fieldName: info[2],
    specializationName: info[3],
    info: {
      faculty: info[0],
      fieldOfStudy: info[1],
      period: info[4],
      durationInWeeks: parseInt(info[5]),
      transport: info[6],
      insurance: info[7],
      visa: info[8],
      visaPrice: info[9],
      internshipReferenceNumber: info[12],
    },
    place: {
      locationDescription: bodiesTexts[0],
      aboutCity: bodiesTexts[1],
      aboutSurroundings: bodiesTexts[2],
    },
    work: {
      employerDescription: bodiesTexts[3],
      workDescription: bodiesTexts[4],
      salaryDescription: bodiesTexts[5],
      languageRequirements: bodiesTexts[6],
      accomodation: bodiesTexts[7],
    },
    socialLife: {
      iaesteMembers: bodiesTexts[8],
      foreignStudents: bodiesTexts[9],
      sportAndCulture: bodiesTexts[10],
      food: bodiesTexts[11],
    },
    miscellaneous: {
      communicationWithHome: bodiesTexts[12],
      recommendations: bodiesTexts[13],
      dontForget: bodiesTexts[14],
      benefits: bodiesTexts[15],
      localIaesteCooperation: bodiesTexts[16],
      overallExperienceWithIaeste: bodiesTexts[17],
      otherComments: bodiesTexts[21],
    },
    websites: {
      student: bodiesTexts[18],
      employer: bodiesTexts[19],
      other: bodiesTexts[20].split("\n"),
    },
  };
}

export interface Review extends Omit<ReviewEntry, "location">, Omit<ReviewContent, "fieldName" | "specializationName"> {
  /*
   * The `location` field on ReviewEntry might have either
   * the format "{City}" (returned by getReviewEntriesByCountry),
   * or the format "{Country}, {City}" (returned by
   * getReviewEntriesByField and getReviewEntriesBySpecialization).
   * Here, we want to be sure it's the city.
   */
  city: string;

  countryId: number;
  fieldId: number;
  specializationId?: number;
}
export interface AllReviewData {
  countryCategories: CountryCategory[];
  fields: Field[];
  specializations: Specialization[];
  reviews: Review[];
}
export async function getDataDump(): Promise<AllReviewData> {
  const baseCategories = await getBaseCategories();
  const fields = baseCategories.fields;
  const specializations: Specialization[] = [];

  // Fetch fields and specializations, make lookup tables for them
  const reviewIdToFieldId = new Map<number, number>();

  await PromisePool.withConcurrency(MAX_CONCURRENT_REQUESTS)
    .for(fields)
    .process(async (field) => {
      const cache: Cache = new Map(); // avoid requesting the url twice
      const fieldReviews = await getReviewEntriesByField(field.id, cache);
      const fieldSpecializations = await getSpecializationsOfField(field.id, cache);
      specializations.push(...fieldSpecializations);

      for (const review of fieldReviews) {
        reviewIdToFieldId.set(review.id, field.id);
      }
    });

  const specializationNameToId = new Map<string, number>();
  for (const { id, name } of specializations) {
    specializationNameToId.set(name.en, id);
    specializationNameToId.set(name.cs, id);
  }

  // Now we actually get the data becuase we need to get them by country to get the city name
  const countryCategories = baseCategories.countryCategories;
  const countries = countryCategories.flatMap((category) => category.countries);
  const reviews: Review[] = [];

  await PromisePool.withConcurrency(MAX_CONCURRENT_COUNTRIES)
    .for(countries)
    .process(async (country) => {
      const countryId = country.id;
      const reviewEntries = await getReviewEntriesByCountry(countryId);

      const reviewData = await PromisePool.withConcurrency(MAX_CONCURRENT_REQUESTS / MAX_CONCURRENT_COUNTRIES)
        .for(reviewEntries)
        .process((entry) => getReviewContent(entry.id).then((content) => ({ entry, content })));

      for (const { entry, content } of reviewData.results) {
        const reviewId = entry.id;
        const fieldId = reviewIdToFieldId.get(reviewId)!;
        const specializationId = specializationNameToId.get(content.specializationName); // FIXME doesn't care about field

        reviews.push({
          countryId,
          fieldId,
          specializationId,
          city: entry.location,

          ...omit(entry, "location"),
          ...omit(content, "fieldName", "specializationName"),
        });
      }
    });

  return {
    countryCategories,
    fields,
    specializations,
    reviews,
  };
}
