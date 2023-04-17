import { PromisePool } from "@supercharge/promise-pool";
import { JSDOM } from "jsdom";
const domParser = new new JSDOM().window.DOMParser();
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

const TOTAL_TIMER_LABEL = "Everything completed in";

async function urlToDocument(url: string, cache?: Cache, retries = 5): Promise<Document> {
  const cachedDoc = cache?.get(url);
  if (cachedDoc) return cachedDoc;

  const response = await fetch(url);

  if (!response.ok) {
    if (retries <= 0) throw Error(`Failed to fetch URL: ${url}`);
    // wait for 1s, 2s, 3.5s, 10s, 50s before trying again
    // maximum wait time before failing is ~1 min
    await delay(50_000 / retries ** 1.5);
    return urlToDocument(url, cache, retries - 1);
  }

  const text = await response.text();
  const doc = parseDom(text, "text/html");
  if (cache) cache.set(url, doc);

  return doc;
}

type Cache = Map<string, Document>;
type nullish = null | undefined;
const isAnchor = (el: Element | nullish): el is HTMLAnchorElement => el?.matches("a") ?? false;
const textOf = (el: Element | nullish): string => el?.textContent?.trim() ?? "";
const omit = <T extends Record<any, any>, K extends string & keyof T>(obj: T, ...keys: K[]): Omit<T, K> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !(keys as string[]).includes(k))) as any;
const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const mapOpt = <S, T>(v: S | undefined, f: (v: S) => T | undefined): T | undefined =>
  v === undefined ? undefined : f(v);

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
async function getBaseTableCells(lang: string, cache?: Cache) {
  const doc = await urlToDocument(BASE_URL + LANG_URL_FRAGMENT + lang, cache);
  const table = doc.querySelector(".content .tablediv table");
  return [...(table?.querySelectorAll("td") ?? [])];
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
        [...doc.querySelectorAll<HTMLAnchorElement>(`a[href*="&faculty=${fieldId}"]`)]
          .map((a) => ({
            name: textOf(a),
            id: Number(a.href.match(SPECIALIZATION_URL_FRAGMENT_REGEX)?.[1] ?? -1),
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
  const report = doc.querySelector(".student_report")!;

  // This here gets the year of study from the report title
  const yearOfStudy = textOf(report.querySelector("h4")).match(/year (.*)$/i)?.[1] ?? "";

  const photoLinks = [...(report.querySelector(".gallery")?.querySelectorAll("a") ?? [])];
  const photos = photoLinks.map(
    (a): Photo => ({
      fullSizeUrl: ROOT_URL + a.href,
      thumbnailUrl: mapOpt(a.querySelector("img")?.src, (s) => ROOT_URL + s) ?? "",
    })
  );

  const infoTable = report.querySelector("table.header");
  const infoRows = [...(infoTable?.querySelectorAll("tr") ?? [])];
  const infoCells = infoRows.map((row) => [...row.querySelectorAll("td")].map(textOf) as [string, string]);
  const info = infoCells.map((innerArray) => innerArray[1]);

  // it seems all the actual text is in elements with the body class
  const reportBodies = report.querySelector("#report_body")?.querySelectorAll(".body");
  const bodiesTexts = [...(reportBodies ?? [])].map((body) => textOf(body));

  return {
    id,
    yearOfStudy,
    photos,
    fieldName: info[2],
    specializationName: info[3].trim(),
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
  console.log("Fetching base categories");
  console.time(TOTAL_TIMER_LABEL);
  const baseCategories = await getBaseCategories();
  const fields = baseCategories.fields;
  const specializations: Specialization[] = [];

  // Fetch fields and specializations, make lookup tables for them
  let reviewIdToFieldId = new Map<number, number>();

  await PromisePool.withConcurrency(MAX_CONCURRENT_REQUESTS)
    .for(fields)
    .process(async (field) => {
      console.time(field.name.en);
      const cache: Cache = new Map(); // avoid requesting the url twice
      const fieldReviews = await getReviewEntriesByField(field.id, cache);
      const fieldSpecializations = await getSpecializationsOfField(field.id, cache);
      specializations.push(...fieldSpecializations);

      for (const review of fieldReviews) {
        reviewIdToFieldId.set(review.id, field.id);
      }
      console.timeEnd(field.name.en);
    });

  let specializationNameToId = new Map<string, number>();
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
      console.time(country.name.en);
      const countryId = country.id;
      const reviewEntries = await getReviewEntriesByCountry(countryId);

      const reviewData = await PromisePool.withConcurrency(MAX_CONCURRENT_REQUESTS / MAX_CONCURRENT_COUNTRIES)
        .for(reviewEntries)
        .process((entry) => getReviewContent(entry.id).then((content) => ({ entry, content })));

      for (const { entry, content } of reviewData.results) {
        const reviewId = entry.id;
        const fieldId = reviewIdToFieldId.get(reviewId)!;
        const specializationId = specializationNameToId.get(content.specializationName);

        reviews.push({
          countryId,
          fieldId,
          specializationId,
          city: entry.location,

          ...omit(entry, "location"),
          ...omit(content, "fieldName", "specializationName"),
        });
      }
      console.timeEnd(country.name.en);
    });

  console.timeEnd(TOTAL_TIMER_LABEL);
  return {
    countryCategories,
    fields,
    specializations,
    reviews,
  };
}
