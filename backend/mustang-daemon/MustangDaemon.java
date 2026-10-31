import java.io.*;
import java.nio.charset.StandardCharsets;
import org.mustangproject.validator.ZUGFeRDValidator;

/**
 * Long-running Mustang validation daemon consumed by the Rust process pool.
 *
 * Protocol (UTF-8, newline-delimited):
 *   Startup  → "READY\n"
 *   Request  ← absolute path to an XML temp file
 *   Response → "EXIT:<code>\n"
 *              "LENGTH:<n>\n"
 *              <n bytes of validation XML report>
 *              "\n"   (only when n > 0)
 *
 * exit code 0   = valid
 * exit code 255 = invalid (Mustang convention)
 * exit code 2   = internal error (report is empty; Rust maps to Unavailable)
 */
public class MustangDaemon {
    public static void main(String[] args) throws IOException {
        // Wrap stdout so we control flushing; never let libraries print to it.
        PrintStream proto = new PrintStream(
            new BufferedOutputStream(System.out), false, StandardCharsets.UTF_8);
        // Silence any library chatter on stdout.
        System.setOut(new PrintStream(OutputStream.nullOutputStream()));

        BufferedReader stdin = new BufferedReader(
            new InputStreamReader(System.in, StandardCharsets.UTF_8));

        proto.println("READY");
        proto.flush();

        String line;
        while ((line = stdin.readLine()) != null) {
            String path = line.trim();
            if (path.isEmpty()) continue;

            byte[] reportBytes = new byte[0];
            int exitCode = 2;
            try {
                ZUGFeRDValidator v = new ZUGFeRDValidator();
                v.disableNotices();
                String report = v.validate(path);
                // Same as Mustang CLI `--action validate`: System.exit(-1) (255) unless completely valid.
                exitCode = v.wasCompletelyValid() ? 0 : 255;
                if (report != null) {
                    reportBytes = report.getBytes(StandardCharsets.UTF_8);
                }
            } catch (Exception ignored) {
                // exitCode stays 2, reportBytes stays empty → Rust returns Unavailable
            }

            proto.println("EXIT:" + exitCode);
            proto.println("LENGTH:" + reportBytes.length);
            proto.flush();
            if (reportBytes.length > 0) {
                proto.write(reportBytes);
                proto.write('\n');
                proto.flush();
            }
        }
    }
}
