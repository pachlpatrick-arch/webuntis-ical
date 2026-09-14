const fs = require("fs");
const crypto = require("crypto");
const { WebUntis } = require("webuntis");

const CONFIG = {
  server: process.env.WEBUNTIS_SERVER || "elgym.webuntis.com",
  school: process.env.WEBUNTIS_SCHOOL || "elgym",
  username: process.env.WEBUNTIS_USERNAME,
  password: process.env.WEBUNTIS_PASSWORD,

  // Wie viele Tage rückwirkend und im Voraus exportiert werden.
  daysPast: Number(process.env.DAYS_PAST || 14),
  daysFuture: Number(process.env.DAYS_FUTURE || 120),

  outputFile: process.env.OUTPUT_FILE || "stundenplan.ics",
  calendarName: process.env.CALENDAR_NAME || "WebUntis Stundenplan",
  timezone: "Europe/Vienna"
};

function requireEnvironmentVariable(name, value) {
  if (!value) {
    throw new Error(
      `Die Umgebungsvariable ${name} fehlt. Bitte als GitHub Secret hinterlegen.`
    );
  }
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function parseUntisDate(value) {
  const text = String(value);

  if (!/^\d{8}$/.test(text)) {
    throw new Error(`Ungültiges WebUntis-Datum: ${value}`);
  }

  return {
    year: Number(text.slice(0, 4)),
    month: Number(text.slice(4, 6)),
    day: Number(text.slice(6, 8))
  };
}

function parseUntisTime(value) {
  const text = String(value).padStart(4, "0");

  return {
    hour: Number(text.slice(0, 2)),
    minute: Number(text.slice(2, 4))
  };
}

function toIcalLocalDateTime(untisDate, untisTime) {
  const date = parseUntisDate(untisDate);
  const time = parseUntisTime(untisTime);

  return (
    `${date.year}${pad(date.month)}${pad(date.day)}` +
    `T${pad(time.hour)}${pad(time.minute)}00`
  );
}

function toUntisDate(date) {
  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}`
  );
}

function toUtcTimestamp(date = new Date()) {
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

function escapeIcalText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldIcalLine(line) {
  const bytes = Buffer.from(line, "utf8");

  if (bytes.length <= 73) {
    return line;
  }

  const parts = [];
  let current = "";
  let currentLength = 0;

  for (const character of line) {
    const characterLength = Buffer.byteLength(character, "utf8");

    if (currentLength + characterLength > 73) {
      parts.push(current);
      current = " " + character;
      currentLength = 1 + characterLength;
    } else {
      current += character;
      currentLength += characterLength;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts.join("\r\n");
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function uniqueNames(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return [
    ...new Set(
      items
        .map((item) => item?.longname || item?.name || item?.displayName)
        .filter(Boolean)
    )
  ];
}

function getSubjectNames(lesson) {
  return uniqueNames(lesson.su || lesson.subjects);
}

function getTeacherNames(lesson) {
  return uniqueNames(lesson.te || lesson.teachers);
}

function getRoomNames(lesson) {
  return uniqueNames(lesson.ro || lesson.rooms);
}

function isCancelledLesson(lesson) {
  const searchableText = [
    lesson.code,
    lesson.lessonCode,
    lesson.cellState,
    lesson.substText,
    lesson.info,
    lesson.lstext,
    lesson.lessonText,
    lesson.periodText,
    lesson.periodInfo
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    lesson.code === "cancelled" ||
    searchableText.includes("cancelled") ||
    searchableText.includes("entfällt") ||
    searchableText.includes("entfall") ||
    searchableText.includes("cancel")
  );
}

function isSubstitutionLesson(lesson) {
  if (isCancelledLesson(lesson)) {
    return false;
  }

  const searchableText = [
    lesson.code,
    lesson.lessonCode,
    lesson.cellState,
    lesson.substText,
    lesson.info,
    lesson.lstext,
    lesson.lessonText,
    lesson.periodText,
    lesson.periodInfo,
    lesson.activityType
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    lesson.code === "irregular" ||
    lesson.cellState === "SUBSTITUTION" ||
    lesson.cellState === "ROOMSUBSTITUTION" ||
    lesson.is?.substitution === true ||
    lesson.is?.roomSubstitution === true ||
    searchableText.includes("substitution") ||
    searchableText.includes("supplier") ||
    searchableText.includes("suppliert") ||
    searchableText.includes("vertretung")
  );
}

function createUid(lesson) {
  const stableInput = [
    CONFIG.school,
    lesson.id,
    lesson.lessonId || lesson.lsnumber || "",
    lesson.date,
    lesson.startTime,
    lesson.endTime
  ].join("-");

  const hash = crypto
    .createHash("sha256")
    .update(stableInput)
    .digest("hex")
    .slice(0, 32);

  return `${hash}@webuntis-ical`;
}

function createEvent(lesson, generatedAt) {
  const subjects = getSubjectNames(lesson);
  const teachers = getTeacherNames(lesson);
  const rooms = getRoomNames(lesson);

  let title = subjects.length > 0 ? subjects.join(", ") : "Unterricht";
  let statusText = "Regulärer Unterricht";
  let color = "#2563EB";
  let transparency = "OPAQUE";

  if (isCancelledLesson(lesson)) {
    title += " - Entfällt";
    statusText = "Entfällt";
    color = "#DC2626";
    transparency = "TRANSPARENT";
  } else if (isSubstitutionLesson(lesson)) {
    title += " - suppliert";
    statusText = "suppliert";
    color = "#16A34A";
  }

  const descriptionParts = [
    `Status: ${statusText}`,
    teachers.length > 0 ? `Lehrkraft: ${teachers.join(", ")}` : null,
    rooms.length > 0 ? `Raum: ${rooms.join(", ")}` : null,
    lesson.substText ? `Vertretungstext: ${lesson.substText}` : null,
    lesson.info ? `Information: ${lesson.info}` : null,
    lesson.lstext ? `Unterrichtstext: ${lesson.lstext}` : null,
    lesson.lessonText ? `Unterrichtstext: ${lesson.lessonText}` : null,
    lesson.periodText ? `Stundentext: ${lesson.periodText}` : null,
    lesson.periodInfo ? `Stundeninformation: ${lesson.periodInfo}` : null
  ].filter(Boolean);

  const lines = [
    "BEGIN:VEVENT",
    `UID:${createUid(lesson)}`,
    `DTSTAMP:${generatedAt}`,
    `LAST-MODIFIED:${generatedAt}`,
    `DTSTART;TZID=${CONFIG.timezone}:${toIcalLocalDateTime(
      lesson.date,
      lesson.startTime
    )}`,
    `DTEND;TZID=${CONFIG.timezone}:${toIcalLocalDateTime(
      lesson.date,
      lesson.endTime
    )}`,
    `SUMMARY:${escapeIcalText(title)}`,
    `DESCRIPTION:${escapeIcalText(descriptionParts.join("\n"))}`,
    `LOCATION:${escapeIcalText(rooms.join(", "))}`,
    `TRANSP:${transparency}`,
    `COLOR:${color}`,
    `X-APPLE-CALENDAR-COLOR:${color}`,
    "STATUS:CONFIRMED",
    "END:VEVENT"
  ];

  return lines.map(foldIcalLine).join("\r\n");
}

function createCalendar(lessons) {
  const generatedAt = toUtcTimestamp();

  const header = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "PRODID:-//WebUntis iCal GitHub//DE",
    `X-WR-CALNAME:${escapeIcalText(CONFIG.calendarName)}`,
    `X-WR-TIMEZONE:${CONFIG.timezone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT5H",
    "X-PUBLISHED-TTL:PT5H",
    "BEGIN:VTIMEZONE",
    `TZID:${CONFIG.timezone}`,
    "X-LIC-LOCATION:Europe/Vienna",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "TZNAME:CEST",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "TZNAME:CET",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE"
  ];

  const events = lessons.map((lesson) => createEvent(lesson, generatedAt));

  return [...header, ...events, "END:VCALENDAR", ""].join("\r\n");
}

async function main() {
  requireEnvironmentVariable("WEBUNTIS_USERNAME", CONFIG.username);
  requireEnvironmentVariable("WEBUNTIS_PASSWORD", CONFIG.password);

  console.log(`WebUntis-Server: ${CONFIG.server}`);
  console.log(`Schulkennung: ${CONFIG.school}`);
  console.log(`Ausgabedatei: ${CONFIG.outputFile}`);

  const untis = new WebUntis(
    CONFIG.school,
    CONFIG.username,
    CONFIG.password,
    CONFIG.server,
    "GitHub-WebUntis-iCal"
  );

  const startDate = addDays(new Date(), -CONFIG.daysPast);
  const endDate = addDays(new Date(), CONFIG.daysFuture);

  try {
    await untis.login();
    console.log("WebUntis-Anmeldung erfolgreich.");

    const lessons = await untis.getOwnTimetableForRange(startDate, endDate);

    if (!Array.isArray(lessons)) {
      throw new Error("WebUntis hat keine gültige Stundenplanliste geliefert.");
    }

    lessons.sort((a, b) => {
      const first = `${toUntisDate(
        new Date(
          parseUntisDate(a.date).year,
          parseUntisDate(a.date).month - 1,
          parseUntisDate(a.date).day
        )
      )}${String(a.startTime).padStart(4, "0")}`;

      const second = `${toUntisDate(
        new Date(
          parseUntisDate(b.date).year,
          parseUntisDate(b.date).month - 1,
          parseUntisDate(b.date).day
        )
      )}${String(b.startTime).padStart(4, "0")}`;

      return first.localeCompare(second);
    });

    const calendar = createCalendar(lessons);

    fs.writeFileSync(CONFIG.outputFile, calendar, {
      encoding: "utf8"
    });

    const cancelledCount = lessons.filter(isCancelledLesson).length;
    const substitutionCount = lessons.filter(isSubstitutionLesson).length;

    console.log(`Kalendereinträge erzeugt: ${lessons.length}`);
    console.log(`Davon Entfall: ${cancelledCount}`);
    console.log(`Davon suppliert: ${substitutionCount}`);
    console.log(`${CONFIG.outputFile} wurde erfolgreich gespeichert.`);
  } finally {
    try {
      await untis.logout();
    } catch {
      // Ein fehlgeschlagener Logout soll die erzeugte Datei nicht verhindern.
    }
  }
}

main().catch((error) => {
  console.error("Fehler beim Erzeugen des Kalenders:");
  console.error(error?.response?.data || error?.message || error);
  process.exit(1);
});
