import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import { findNearbyDrivers } from "../matching/matching.service.js";
import { calculateFare } from "../fares/fares.config.js";
import { CronExpressionParser } from "cron-parser";

/**
 * A lightweight scheduler that polls the `scheduled_jobs` table and 
 * materializes jobs whose `next_run_at` has passed into active `rides`.
 */
export function startScheduler() {
  logger.info("Fleet Scheduler started...");

  // Poll every 60 seconds
  setInterval(async () => {
    try {
      const now = new Date().toISOString();
      
      const { data: jobs, error } = await supabaseAdmin
        .from("scheduled_jobs")
        .select("*")
        .eq("is_active", true)
        .lte("next_run_at", now);

      if (error || !jobs || jobs.length === 0) return;

      for (const job of jobs) {
        logger.info({ jobId: job.id }, "Materializing scheduled job");

        // 1. Calculate fare / routing via OSRM
        let distanceM = 0;
        let fareEst = 0;
        
        try {
          const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${job.origin_lng},${job.origin_lat};${job.dest_lng},${job.dest_lat}?overview=false`;
          const routeRes = await fetch(osrmUrl);
          const routeData = (await routeRes.json()) as any;
          if (routeData.routes && routeData.routes.length > 0) {
            distanceM = routeData.routes[0].distance;
            const durationS = routeData.routes[0].duration;
            fareEst = calculateFare(job.vehicle_type as any, distanceM, durationS, 1.0, job.cargo_weight_kg);
          }
        } catch (e) {
          logger.warn({ err: e }, "OSRM calculation failed in scheduler, defaulting to 0");
        }

        // 2. Insert into rides table
        const { data: ride, error: rideError } = await supabaseAdmin
          .from("rides")
          .insert({
            origin_lat: job.origin_lat,
            origin_lng: job.origin_lng,
            origin_address: job.origin_address,
            dest_lat: job.dest_lat,
            dest_lng: job.dest_lng,
            dest_address: job.dest_address,
            vehicle_type: job.vehicle_type,
            service_type: "fleet",
            cargo_weight_kg: job.cargo_weight_kg,
            distance_m: distanceM,
            fare_estimate: fareEst,
            status: "requested",
            payment_method: "cash",
            payment_status: "pending",
          })
          .select()
          .single();

        if (rideError) {
          logger.error({ jobId: job.id, err: rideError }, "Failed to materialize scheduled job");
          continue;
        }

        // 3. Mark job as complete (or calculate next_run_at if recurring)
        if (!job.is_recurring || !job.cron_expression) {
          await supabaseAdmin
            .from("scheduled_jobs")
            .update({ is_active: false })
            .eq("id", job.id);
        } else {
          try {
            // Calculate next run time using cron parser (v5 API)
            const interval = CronExpressionParser.parse(job.cron_expression);
            const nextRun = interval.next().toISOString();
            await supabaseAdmin
              .from("scheduled_jobs")
              .update({ next_run_at: nextRun })
              .eq("id", job.id);
          } catch (e) {
            logger.error({ jobId: job.id, err: e }, "Failed to parse cron expression");
            await supabaseAdmin.from("scheduled_jobs").update({ is_active: false }).eq("id", job.id);
          }
        }

        // 4. Trigger matching
        findNearbyDrivers(
          job.origin_lat, 
          job.origin_lng, 
          job.vehicle_type, 
          ride.id, 
          "fleet", 
          job.cargo_weight_kg
        ).catch(() => {});
      }
    } catch (err) {
      logger.error({ err }, "Scheduler loop error");
    }
  }, 60 * 1000);
}
