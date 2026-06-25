import { ClassPassBrowser } from "./browser.js";

type SearchClassesArgs = {
  location: string;
  date: string;
  class_type?: string;
  time_range?: string;
};

type ScheduleArgs = {
  start_date?: string;
  end_date?: string;
};

type ClassSummary = {
  id: string | null;
  name: string;
  studio: string;
  instructor: string;
  date: string;
  time: string;
  duration: string;
  credits: string;
  spotsLeft: string;
  address: string;
};

type ClassDetails = ClassSummary & {
  description: string;
  amenities: string[];
  cancellationPolicy: string;
};

type Booking = {
  id: string | null;
  classId?: string | null;
  name: string;
  studio: string;
  date: string;
  time: string;
  status: string;
  address: string;
};

type Favorite = {
  id: string | null;
  name: string;
  neighborhood: string;
  address: string;
  rating: string;
};

type Studio = Favorite & {
  distance: string;
  credits: string;
};

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return `https://classpass.com${path}${query ? `?${query}` : ""}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ClassPassSession {
  public isLoggedIn = false;
  private browser = new ClassPassBrowser();

  async initialize(): Promise<void> {
    try {
      await this.browser.initialize();
    } catch (error) {
      this.isLoggedIn = false;
      throw error;
    }
  }

  async login(email: string, password: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.browser.navigate("https://classpass.com/login");
      const emailSelector = 'input[name="email"], input[type="email"]';
      const passwordSelector = 'input[name="password"], input[type="password"]';
      await this.browser.waitForSelector(emailSelector, 60000);
      await this.browser.fill(emailSelector, email);
      await this.browser.fill(passwordSelector, password);
      await this.browser.click('button[type="submit"]');
      const page = await this.browser.getPage();
      await page.waitForTimeout(3000);
      this.isLoggedIn = true;
      return { success: true, message: "Logged in to ClassPass." };
    } catch (error) {
      this.isLoggedIn = false;
      return { success: false, message: `Login failed: ${getErrorMessage(error)}` };
    }
  }

  async searchClasses(args: SearchClassesArgs): Promise<{ classes: ClassSummary[] }> {
    try {
      const url = buildUrl("/classes", {
        location: args.location,
        date: args.date,
        class_type: args.class_type,
        time: args.time_range,
      });
      await this.browser.navigate(url);
      await this.browser.waitForSelector('[data-testid="ClassCard"]');
      const classes = await this.browser.evaluate<ClassSummary[]>(() => {
        const text = (root: Element, testId: string) =>
          root.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() || "";
        return Array.from(document.querySelectorAll('[data-testid="ClassCard"]'))
          .slice(0, 30)
          .map((card) => ({
            id: card.getAttribute("data-class-id"),
            name: text(card, "ClassName"),
            studio: text(card, "StudioName"),
            instructor: text(card, "InstructorName"),
            date: text(card, "ClassDate"),
            time: text(card, "ClassTime"),
            duration: text(card, "ClassDuration"),
            credits: text(card, "ClassCredits"),
            spotsLeft: text(card, "SpotsLeft"),
            address: text(card, "StudioAddress"),
          }));
      });
      return { classes };
    } catch {
      return { classes: [] };
    }
  }

  async getClassDetails(classId: string): Promise<{ class?: ClassDetails; error?: string }> {
    try {
      await this.browser.navigate(`https://classpass.com/classes/${encodeURIComponent(classId)}`);
      await this.browser.waitForSelector('[data-testid="ClassDetail"]');
      const classDetails = await this.browser.evaluate<ClassDetails>(() => {
        const root = document.querySelector('[data-testid="ClassDetail"]') || document.body;
        const text = (testId: string) => root.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() || "";
        return {
          id: root.getAttribute("data-class-id"),
          name: text("ClassName"),
          studio: text("StudioName"),
          instructor: text("InstructorName"),
          date: text("ClassDate"),
          time: text("ClassTime"),
          duration: text("ClassDuration"),
          credits: text("ClassCredits"),
          spotsLeft: text("SpotsLeft"),
          address: text("StudioAddress"),
          description: text("ClassDescription"),
          amenities: Array.from(root.querySelectorAll('[data-testid="Amenity"]')).map(
            (amenity) => amenity.textContent?.trim() || "",
          ),
          cancellationPolicy: text("CancellationPolicy"),
        };
      });
      return { class: classDetails };
    } catch (error) {
      return { error: `Unable to get class details: ${getErrorMessage(error)}` };
    }
  }

  async bookClass(classId: string): Promise<{ success: boolean; booking?: Booking; message: string }> {
    try {
      await this.browser.navigate(`https://classpass.com/classes/${encodeURIComponent(classId)}`);
      await this.browser.click('[data-testid="BookButton"]');
      const page = await this.browser.getPage();
      const confirmButton = await page.waitForSelector('[data-testid="ConfirmBooking"]', { timeout: 5000 }).catch(() => null);
      if (confirmButton) {
        await confirmButton.click();
      }
      await page.waitForTimeout(3000);
      const booking = await this.browser.evaluate<Booking>(() => {
        const root =
          document.querySelector('[data-testid="BookingConfirmation"]') ||
          document.querySelector('[data-testid="ReservationCard"]') ||
          document.body;
        const text = (testId: string) => root.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() || "";
        return {
          id: root.getAttribute("data-booking-id"),
          classId: root.getAttribute("data-class-id"),
          name: text("ClassName"),
          studio: text("StudioName"),
          date: text("ClassDate"),
          time: text("ClassTime"),
          status: text("BookingStatus") || "booked",
          address: text("StudioAddress"),
        };
      });
      return { success: true, booking, message: "Class booked." };
    } catch (error) {
      return { success: false, message: `Booking failed: ${getErrorMessage(error)}` };
    }
  }

  async cancelBooking(bookingId: string): Promise<{ success: boolean; creditsRefunded?: string; message: string }> {
    try {
      await this.browser.navigate(`https://classpass.com/account/reservations/${encodeURIComponent(bookingId)}`);
      await this.browser.click('[data-testid="CancelBookingButton"]');
      await this.browser.click('[data-testid="ConfirmCancellation"]');
      const creditsRefunded = await this.browser.evaluate<string>(() => {
        return document.querySelector('[data-testid="CreditsRefunded"]')?.textContent?.trim() || "";
      });
      return { success: true, creditsRefunded, message: "Booking canceled." };
    } catch (error) {
      return { success: false, message: `Cancellation failed: ${getErrorMessage(error)}` };
    }
  }

  async getSchedule(args: ScheduleArgs = {}): Promise<{ bookings: Booking[] }> {
    try {
      const url = buildUrl("/account/reservations", {
        start_date: args.start_date,
        end_date: args.end_date,
      });
      await this.browser.navigate(url);
      const bookings = await this.browser.evaluate<Booking[]>(() => {
        const text = (root: Element, testId: string) =>
          root.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() || "";
        return Array.from(document.querySelectorAll('[data-testid="ReservationCard"]')).map((card) => ({
          id: card.getAttribute("data-booking-id"),
          classId: card.getAttribute("data-class-id"),
          name: text(card, "ClassName"),
          studio: text(card, "StudioName"),
          date: text(card, "ClassDate"),
          time: text(card, "ClassTime"),
          status: text(card, "BookingStatus"),
          address: text(card, "StudioAddress"),
        }));
      });
      return { bookings };
    } catch {
      return { bookings: [] };
    }
  }

  async getCreditsBalance(): Promise<{ balance?: string; details?: Record<string, string>; error?: string }> {
    try {
      await this.browser.navigate("https://classpass.com/account/credits");
      const result = await this.browser.evaluate<{ balance: string; details: Record<string, string> }>(() => {
        const detailEntries = Array.from(document.querySelectorAll('[data-testid="CreditDetail"]')).map((detail) => {
          const label = detail.querySelector('[data-testid="CreditDetailLabel"]')?.textContent?.trim() || "";
          const value = detail.querySelector('[data-testid="CreditDetailValue"]')?.textContent?.trim() || "";
          return [label, value] as [string, string];
        });
        return {
          balance: document.querySelector('[data-testid="CreditsBalance"]')?.textContent?.trim() || "",
          details: Object.fromEntries(detailEntries.filter(([label]) => label)),
        };
      });
      return result;
    } catch (error) {
      return { error: `Unable to get credits balance: ${getErrorMessage(error)}` };
    }
  }

  async getFavorites(): Promise<{ favorites: Favorite[] }> {
    try {
      await this.browser.navigate("https://classpass.com/account/favorites");
      const favorites = await this.browser.evaluate<Favorite[]>(() => {
        const text = (root: Element, testId: string) =>
          root.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() || "";
        return Array.from(document.querySelectorAll('[data-testid="FavoriteCard"]')).map((card) => ({
          id: card.getAttribute("data-studio-id"),
          name: text(card, "StudioName"),
          neighborhood: text(card, "StudioNeighborhood"),
          address: text(card, "StudioAddress"),
          rating: text(card, "StudioRating"),
        }));
      });
      return { favorites };
    } catch {
      return { favorites: [] };
    }
  }

  async addFavorite(studioId: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.browser.navigate(`https://classpass.com/studios/${encodeURIComponent(studioId)}`);
      await this.browser.click('[data-testid="FavoriteButton"]');
      return { success: true, message: "Studio added to favorites." };
    } catch (error) {
      return { success: false, message: `Unable to add favorite: ${getErrorMessage(error)}` };
    }
  }

  async getNearbyStudios(location: string, radius?: number): Promise<{ studios: Studio[] }> {
    try {
      const url = buildUrl("/studios", { location, radius });
      await this.browser.navigate(url);
      const studios = await this.browser.evaluate<Studio[]>(() => {
        const text = (root: Element, testId: string) =>
          root.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() || "";
        return Array.from(document.querySelectorAll('[data-testid="StudioCard"]'))
          .slice(0, 30)
          .map((card) => ({
            id: card.getAttribute("data-studio-id"),
            name: text(card, "StudioName"),
            neighborhood: text(card, "StudioNeighborhood"),
            address: text(card, "StudioAddress"),
            rating: text(card, "StudioRating"),
            distance: text(card, "StudioDistance"),
            credits: text(card, "StudioCredits"),
          }));
      });
      return { studios };
    } catch {
      return { studios: [] };
    }
  }

  async close(): Promise<void> {
    try {
      await this.browser.close();
    } catch {
      // Keep close idempotent for MCP shutdown paths.
    } finally {
      this.isLoggedIn = false;
    }
  }
}
