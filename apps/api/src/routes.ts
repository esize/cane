import express, { Request, Response, NextFunction } from "express";
import { subHours, parseISO, isValid } from "date-fns";
import { GribService } from "./gribService";
import { formatDateStamp } from "./helper";
import fs from "fs/promises";
import path from "path";

const router: express.Router = express.Router();

// Routes
router.get("/", (_req: Request, res: Response) => {
  res.send(
    "Welcome to the wind-js-server. Go to /latest for the latest wind data."
  );
});

router.get("/alive", (_req: Request, res: Response) => {
  res.send("wind-js-server is alive");
});

router.get(
  "/latest",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const latestAvailable = await GribService.getLatestAvailableTimestamp();
      let gribData = await GribService.getGribData(latestAvailable);

      // If no data was downloaded, try the previous 6-hour interval
      if (!gribData.downloaded) {
        const previousTimestamp = subHours(latestAvailable, 6);
        gribData = await GribService.getGribData(previousTimestamp);
      }

      if (gribData.stamp) {
        const jsonFilePath = path.resolve(
          __dirname,
          "..",
          "json-data",
          `${gribData.stamp}.json`
        );

        try {
          // Check if the file exists and is readable
          await fs.access(jsonFilePath, fs.constants.R_OK);

          // Read the file contents
          const fileContents = await fs.readFile(jsonFilePath, "utf8");

          // Send the file contents as JSON
          res.json(JSON.parse(fileContents));
        } catch (error) {
          if (error instanceof Error) {
            if ("code" in error) {
              switch (error.code) {
                case "ENOENT":
                  // File doesn't exist, try to convert GRIB to JSON
                  await GribService.convertGribToJson(
                    gribData.stamp,
                    gribData.targetDate as Date
                  );
                  res
                    .status(202)
                    .send(
                      "Data is being processed. Please try again in a few moments."
                    );
                  break;
                case "EACCES":
                  // Permission denied
                  console.error(
                    `Permission denied when trying to read ${jsonFilePath}`
                  );
                  res
                    .status(500)
                    .send(
                      "Server configuration error: Unable to read data file"
                    );
                  break;
                default:
                  // Other errors
                  console.error(`Error reading file ${jsonFilePath}:`, error);
                  res.status(500).send("Error reading data file");
              }
            } else {
              // Handle non-filesystem errors
              console.error(`Unexpected error:`, error);
              res.status(500).send("An unexpected error occurred");
            }
          } else {
            // Handle non-Error objects
            console.error(`Unknown error type:`, error);
            res.status(500).send("An unknown error occurred");
          }
        }
      } else {
        res.status(404).send("No data available. Please try again later.");
      }
    } catch (error) {
      console.error("Error in /latest route:", error);
      next(error);
    }
  }
);

router.get(
  "/nearest",
  async (req: Request, res: Response, next: NextFunction) => {
    const timeIso = req.query.timeIso as string;
    const searchLimit = req.query.searchLimit
      ? parseInt(req.query.searchLimit as string)
      : undefined;

    if (timeIso && isValid(parseISO(timeIso))) {
      try {
        await sendNearestTo(res, parseISO(timeIso), searchLimit);
      } catch (error) {
        next(error);
      }
    } else {
      next(new Error("Invalid params, expecting: timeIso=ISO_TIME_STRING"));
    }
  }
);

async function sendLatest(res: Response, targetDate: Date): Promise<void> {
  const stamp = formatDateStamp(targetDate);
  const fileName = `${__dirname}/../json-data/${stamp}.json`;

  res.setHeader("Content-Type", "application/json");
  res.sendFile(fileName, {}, async (err) => {
    if (err) {
      console.log(`${stamp} doesn't exist yet, trying previous interval..`);
      const gribData = await GribService.getGribData(subHours(targetDate, 6));
      if (gribData.stamp) {
        GribService.convertGribToJson(
          gribData.stamp,
          gribData.targetDate as Date
        );
        await sendLatest(res, gribData.targetDate as Date);
      } else {
        res.status(404).send("No data available");
      }
    }
  });
}

async function sendNearestTo(
  res: Response,
  targetDate: Date,
  searchLimit?: number,
  searchForwards: boolean = false
): Promise<void> {
  if (
    searchLimit &&
    Math.abs(new Date().getTime() - targetDate.getTime()) /
      (1000 * 60 * 60 * 24) >=
      searchLimit
  ) {
    if (!searchForwards) {
      const newTarget = new Date(
        targetDate.getTime() + searchLimit * 24 * 60 * 60 * 1000
      );
      return sendNearestTo(res, newTarget, searchLimit, true);
    } else {
      throw new Error("No data within searchLimit");
    }
  }

  const gribData = await GribService.getGribData(targetDate);
  if (gribData.stamp) {
    GribService.convertGribToJson(gribData.stamp, gribData.targetDate as Date);
    const fileName = `${__dirname}/../json-data/${gribData.stamp}.json`;

    res.setHeader("Content-Type", "application/json");
    res.sendFile(fileName, {}, (err) => {
      if (err) {
        const nextTarget = searchForwards
          ? new Date(targetDate.getTime() + 6 * 60 * 60 * 1000)
          : new Date(targetDate.getTime() - 6 * 60 * 60 * 1000);
        sendNearestTo(res, nextTarget, searchLimit, searchForwards);
      }
    });
  } else {
    const nextTarget = searchForwards
      ? new Date(targetDate.getTime() + 6 * 60 * 60 * 1000)
      : new Date(targetDate.getTime() - 6 * 60 * 60 * 1000);
    return sendNearestTo(res, nextTarget, searchLimit, searchForwards);
  }
}

export default router;
