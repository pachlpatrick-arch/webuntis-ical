const fs = require("fs");
const crypto = require("crypto");
const { WebUntis } = require("webuntis");

const CONFIG = {
  server: process.env.WEBUNTIS_SERVER || "elgym.webuntis.com",
  school: process.env.WEBUNTIS_SCHOOL || "elgym",
  username: process.env.WEBUNTIS_USERNAME,
  password: process.env.WEBUNTIS_PASSWORD,

  daysPast: Number(process.env.DAYS_PAST || 14),
  daysFuture: Number(process.env.DAYS_FUTURE || 120),

  outputFile: process.env.OUTPUT_FILE || "stundenplan.ics",
  calendarName:
    process.env.CALENDAR_NAME || "WebUntis Stundenplan",
  timezone: "Europe/Vienna"
};

function requireEnvironmentVariable(name, value) {
  if (!value) {
    throw new Error(
      `Die Umgebungsvariable ${name} fehlt. ` +
        "Bitte als GitHub Secret hinterlegen."
    );
  }
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function parseUntisDate(value) {
  const text = String(value);

  if (!/^\d{8}$/.test(text)) {
    throw new Error(
      `Ungültiges WebUntis-Datum: ${value}`
    );
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
  if (Buffer.byteLength(line, "utf8") <= 73) {
    return line;
  }

  const parts = [];
  let current = "";
  let currentLength = 0;

  for (const character of line) {
    const characterLength = Buffer.byteLength(
      character,
      "utf8"
    );

    if (currentLength + characterLength > 73) {
      parts.push(current);
      current = ` ${character}`;
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
        .map(
          (item) =>
            item?.longname ||
            item?.name ||
            item?.displayName ||
            item?.element?.name
        )
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

function getLessonStatusText(lesson) {
  return [
    lesson.code,
    lesson.lessonCode,
    lesson.cellState,
    lesson.substText,
    lesson.info,
    lesson.lstext,
    lesson.lessonText,
    lesson.periodText,
    lesson.periodInfo,
    lesson.activityType,
    lesson.statflags,
    lesson.is?.event ? "event" : "",
    lesson.is?.standard ? "standard" : "",
    lesson.is?.substitution
      ? "substitution"
      : "",
    lesson.is?.roomSubstitution
      ? "roomsubstitution"
      : ""
  ]
    .filter(
      (value) =>
        value !== undefined && value !== null
    )
    .map((value) => String(value))
    .join(" ")
    .toLowerCase();
}

function isCancelledLesson(lesson) {
  const statusText = getLessonStatusText(lesson);
  const code = String(
    lesson.code || ""
  ).toLowerCase();
  const lessonCode = String(
    lesson.lessonCode || ""
  ).toLowerCase();

  return (
    code === "cancelled" ||
    code === "canceled" ||
    lessonCode === "cancelled" ||
    lessonCode === "canceled" ||
    statusText.includes("cancelled") ||
    statusText.includes("canceled") ||
    statusText.includes("entfällt") ||
    statusText.includes("entfaellt") ||
    statusText.includes("entfall") ||
    statusText.includes("ausfall")
  );
}

function isSubstitutionLesson(lesson) {
  if (isCancelledLesson(lesson)) {
    return false;
  }

  const statusText = getLessonStatusText(lesson);
  const code = String(
    lesson.code || ""
  ).toLowerCase();
  const lessonCode = String(
    lesson.lessonCode || ""
  ).toLowerCase();
  const cellState = String(
    lesson.cellState || ""
  ).toUpperCase();

  return (
    code === "irregular" ||
    lessonCode === "irregular" ||
    cellState === "SUBSTITUTION" ||
    cellState === "ROOMSUBSTITUTION" ||
    lesson.is?.substitution === true ||
    lesson.is?.roomSubstitution === true ||
    statusText.includes("substitution") ||
    statusText.includes("roomsubstitution") ||
    statusText.includes("supplier") ||
    statusText.includes("suppliert") ||
    statusText.includes("supplierung") ||
    statusText.includes("vertretung")
  );
}

function getLessonStatus(lesson) {
  if (isCancelledLesson(lesson)) {
    return {
      titlePrefix: "Entfällt: ",
      description: "Entfällt",
      color: "#DC2626",
      transparency: "TRANSPARENT"
    };
  }

  if (isSubstitutionLesson(lesson)) {
    return {
      titlePrefix: "Suppliert: ",
      description: "Suppliert",
      color: "#16A34A",
      transparency: "OPAQUE"
    };
  }

  return {
    titlePrefix: "",
    description: "Regulärer Unterricht",
    color: "#2563EB",
    transparency: "OPAQUE"
  };
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

function logChangedLesson(
  lesson,
  subjects,
  status
) {
  if (
    status.description ===
    "Regulärer Unterricht"
  ) {
    return;
  }

  console.log(
    "Geänderte Unterrichtsstunde:",
    JSON.stringify(
      {
        id: lesson.id,
        date: lesson.date,
        startTime: lesson.startTime,
        endTime: lesson.endTime,
        subjects,
        erkannterStatus:
          status.description,
        code: lesson.code,
        lessonCode: lesson.lessonCode,
        cellState: lesson.cellState,
        substText: lesson.substText,
        info: lesson.info,
        lstext: lesson.lstext,
        lessonText: lesson.lessonText,
        periodText: lesson.periodText,
        periodInfo: lesson.periodInfo,
        activityType: lesson.activityType,
        statflags: lesson.statflags,
        is: lesson.is
      },
      null,
      2
    )
  );
}

function createEvent(lesson, generatedAt) {
  const subjects = getSubjectNames(lesson);
  const teachers = getTeacherNames(lesson);
  const rooms = getRoomNames(lesson);
  const status = getLessonStatus(lesson);

  const basicTitle =
    subjects.length > 0
      ? subjects.join(", ")
      : "Unterricht";

  /*
   * Der Status wird bewusst VOR das Fach gesetzt:
   *
   * Entfällt: GEOGRAPHIE
   * Suppliert: PONB
   * MATHEMATIK
   */
  const title =
    `${status.ti*lePrefix}${basicTitle}`;

  logCha*gedLesson(
    lesson,
    subjects,
    status
  );

  const descriptionParts = [
Weitere Zeilen anzeigen
    `Status: ${status.description}`,
    teachers.length > 0
      ? `Lehrkraft: ${teachers.join(", ")}`
      : null,
    rooms.length > 0
      ? `Raum: ${rooms.join(", ")}`
      : null,
    lesson.substText
      ? `Vertretungstext: ${lesson.substText}`
      : null,
    lesson.info
      ? `Information: ${lesson.info}`
      : null,
    lesson.lstext
      ? `Unterrichtstext: ${lesson.lstext}`
      : null,
    lesson.lessonText
      ? `Unterrichtstext: ${lesson.lessonText}`
      : null,
    lesson.periodText
      ? `Stundentext: ${lesson.periodText}`
      : null,
    lesson.periodInfo
      ? `Stundeninformation: ${lesson.periodInfo}`
      : null
  ].filter(Boolean);*
  const lines = [
    "BEGIN:VEVENT",
    `UID:${createUid(lesson)}`,
    `DTSTAMP:${generatedAt}`,
    `LAST-MODIFIED:${generatedAt}`,
    `DTSTART;TZID=${CONFIG.timezone}:` +
      toIcalLocalDateTime(
        lesson.date,
        lesson.startTime
      ),
    `DTEND;TZID=${C*NFIG.timezone}:` +
      toIcalLoc*lDateTime(
        lesson.date,
  *     lesson.endTime
      ),
    `*UMMARY:${escapeIcalText(title)}`,
*   `DESCRIPTION:${escapeIcalText(
*     descriptionParts.join("\n")
 *  )}`,
    `LOCATION:${escapeIcalT*xt(
      rooms.join(", ")
    )}`*
    `TRANSP:${status.transparency*`,
    `COLOR:${status.color}`,
  * `X-APPLE-CALENDAR-COLOR:${status.*olor}`,
    "STATUS:CONFIRMED",
  * "END:VEVENT"
  ];

  return lines*    .map(foldIcalLine)
    .join("*r\n");
}

function createCalendar(*essons) {
  const generatedAt = to*tcTimestamp();

  const header = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "PRODID:-//WebUntis iCal GitHub//DE",
    `X-WR-CALNAME:${escapeIcalText(
      CONFIG.calendarName
    )}`,
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
    "RRULE:FREQ=YEARLY;BYMONTH=3;" +
      "BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "TZNAME:CET",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;" +
      "BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE"
  ];

  const ev*nts = lessons.map(
    (lesson) =>*      createEvent(lesson, generate*At)
  );

  return [
    ...header,
    ...events,
    "END:VCALENDAR",
    ""
  ].join("\r\n");
}

func*ion getLessonSortKey(lesson) {
  r*turn (
    String(lesson.date).pad*tart(8, "0") +
    String(lesson.s*artTime).padStart(
      4,
      *0"
    ) +
    String(lesson.endTi*e).padStart(
      4,
      "0"
  * )
  );
}

async function main() {*  requireEnvironmentVariable(
    *WEBUNTIS_USERNAME",
    CONFIG.use*name
  );

  requireEnvironmentVar*able(
    "WEBUNTIS_PASSWORD",
   *CONFIG.password
  );

  console.lo*(
    `WebUntis-Server: ${CONFIG.s*rver}`
  );
  console.log(
    `Sc*ulkennung: ${CONFIG.school}`
  );
* console.log(
    `Ausgabedatei: $*CONFIG.outputFile}`
  );

  const *ntis = new WebUntis(
    CONFIG.sc*ool,
    CONFIG.username,
    CONFIG.password,
    CONFIG.server,
    "GitHub-WebUntis-iCal"
  );

  const startDate = addDays(
    new Date(),
    -CONFIG.daysPast
  );

  const endDate = addDays(
    new Date(),
    CONFIG.daysFuture
  );

  try {
    await untis.login();

    console.log(
      "WebUntis-Anmeldung erfolgreich."
    );

    const lessons =
      await untis.getOwnTimetableForRange(
        startDate,
        endDate
      );

    if (!Array.isArray(lessons)) {
      throw new Error(
        "WebUntis hat keine gültige " +
          "Stundenplanliste geliefert."
      );
    }

    lessons.sort(
      (firstLesson, secondLesson) =>
        getLessonSortKey(
          firstLesson
        ).localeCompare(
          getLessonSortKey(secondLesson)
        )
    );

    const calendar =
      createCalendar(lessons);

    fs.writeFileSync(
      CONFIG.outputFile,
      calendar,
      {
        encoding: "utf8"
      }
    );

    const cancelledCount =
      lessons.filter(
        isCancelledLesson
      ).length;

    const substitutionCount =
      lessons.filter(
        isSubstitutionLesson
      ).length;

    console.log(
      `Kalendereinträge erzeugt: ` +
        `${lessons.length}`
    );

    console.log(
      `Davon Entfall: ${cancelledCount}`
    );

    console.log(
      `Davon Suppliert: ` +
        `${substitutionCount}`
    );

    console.log(
      `${CONFIG.outputFile} wurde ` +
        "erfolgreich gespeichert."
    );
  } finally {
    try {
      await untis.logout();
    } catch {
      console.log(
        "WebUntis-Abmeldung konnte " +
          "nicht durchgeführt werden."
      );
    }
  }
}

main().catch((error) => {
  console.error(
    "Fehler beim Erzeugen des Kalenders:"
  );

  console.error(
    error?.response?.data ||
      error?.stack ||
      error?.message ||
      error
  );

  process.exit(1);
});
