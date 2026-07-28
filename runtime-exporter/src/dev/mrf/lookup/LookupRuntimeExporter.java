package dev.mrf.lookup;

import java.io.IOException;
import java.lang.annotation.Annotation;
import java.lang.reflect.Array;
import java.lang.reflect.Method;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.PluginCommand;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.java.JavaPlugin;

public final class LookupRuntimeExporter extends JavaPlugin implements CommandExecutor {
    private static final List<Adapter> ADAPTERS = List.of(
        new Adapter(
            "cmi", "CMI", "/cmi", "com/Zrips/CMI/commands/list/",
            "com.Zrips.CMI.Modules.Placeholders.Placeholder$CMIPlaceHolders",
            "com.Zrips.CMI.Modules.Permissions.PermissionsManager$CMIPerm"
        ),
        new Adapter(
            "cmilib", "CMILib", "/cmil", "net/Zrips/CMILib/commands/list/",
            "net.Zrips.CMILib.Placeholders.Placeholder$CMIPlaceHolders",
            "net.Zrips.CMILib.Permissions.CMILPerm"
        ),
        new Adapter(
            "jobs", "Jobs", "/jobs", "com/gamingmesh/jobs/commands/list/",
            "com.gamingmesh.jobs.Placeholders.Placeholder$JobsPlaceHolders",
            "com.gamingmesh.jobs.PermissionManager$prm"
        ),
        new Adapter(
            "residence", "Residence", "/res", "com/bekvon/bukkit/residence/commands/",
            "com.bekvon.bukkit.residence.Placeholders.Placeholder$CMIPlaceHolders",
            "com.bekvon.bukkit.residence.permissions.PermissionManager$ResPerm"
        ),
        new Adapter(
            "trademe", "TradeMe", "/trade", "me/Zrips/TradeMe/commands/list/",
            "me.Zrips.TradeMe.Placeholders.Placeholder$TradeMePlaceHolders",
            "me.Zrips.TradeMe.Permissions.PermissionManager$TradeMePerm"
        ),
        new Adapter(
            "svis", "SelectionVisualizer", "/svis", "com/Zrips/sv/commands/list/",
            null, "com.Zrips.sv.PermissionsManager$CMIPerm"
        ),
        new Adapter(
            "mfm", "MobFarmManager", "/mfm", "com/MobFarmManager/Zrips/commands/list/",
            null, "com.MobFarmManager.Zrips.Util.PermissionsManager$MFMPerm"
        ),
        new Adapter(
            "tryme", "TryMe", "/tryme", "me/Zrips/TryMe/commands/list/",
            "me.Zrips.TryMe.Placeholders.Placeholder$TryMePlaceHolders", null
        ),
        new Adapter("bottledexp", "BottledExp", "/bottle", null, null, null)
    );

    @Override
    public void onEnable() {
        PluginCommand command = getCommand("lookupexport");
        if (command != null) {
            command.setExecutor(this);
        }
    }

    @Override
    public boolean onCommand(CommandSender sender, org.bukkit.command.Command command, String label, String[] args) {
        if (!sender.hasPermission("lookupexporter.run")) {
            return true;
        }

        List<Row> rows = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        for (Adapter adapter : ADAPTERS) {
            Plugin plugin = getServer().getPluginManager().getPlugin(adapter.pluginName());
            if (plugin == null || !plugin.isEnabled()) {
                warnings.add(adapter.id() + ": plugin is not enabled");
                continue;
            }
            inspectCommands(plugin, adapter, rows, warnings);
            inspectEnum(plugin, adapter, "placeholder", adapter.placeholderClass(), rows, warnings);
            inspectEnum(plugin, adapter, "permission", adapter.permissionClass(), rows, warnings);
        }

        rows.sort(
            Comparator.comparing(Row::pluginId)
                .thenComparing(Row::kind)
                .thenComparing(Row::key, String.CASE_INSENSITIVE_ORDER)
        );
        writeRows(rows, warnings);
        getLogger().info("LOOKUP_EXPORT_COMPLETE entries=" + rows.size() + " warnings=" + warnings.size());
        return true;
    }

    private void inspectCommands(Plugin plugin, Adapter adapter, List<Row> rows, List<String> warnings) {
        if (adapter.commandPackage() == null) {
            return;
        }

        try {
            URI source = plugin.getClass().getProtectionDomain().getCodeSource().getLocation().toURI();
            try (JarFile jar = new JarFile(Path.of(source).toFile())) {
                List<String> classNames = jar.stream()
                    .map(JarEntry::getName)
                    .filter(name -> isDirectCommandClass(name, adapter.commandPackage()))
                    .map(name -> name.substring(0, name.length() - 6).replace('/', '.'))
                    .sorted()
                    .toList();

                for (String className : classNames) {
                    Class<?> commandClass = Class.forName(className, false, plugin.getClass().getClassLoader());
                    CommandMetadata metadata = readCommandMetadata(commandClass);
                    String commandName = commandClass.getSimpleName().toLowerCase(Locale.ROOT);
                    String key = adapter.commandRoot() + " " + commandName;
                    rows.add(new Row(
                        "command",
                        adapter.id(),
                        key,
                        cleanText(metadata.description()),
                        cleanText(metadata.arguments()),
                        String.join(",", metadata.aliases()),
                        "runtime-command-registry"
                    ));
                }
            }
        } catch (Exception error) {
            warnings.add(adapter.id() + ": command extraction failed: " + summarize(error));
        }
    }

    private boolean isDirectCommandClass(String name, String commandPackage) {
        if (!name.startsWith(commandPackage) || !name.endsWith(".class") || name.contains("$")) {
            return false;
        }
        String remainder = name.substring(commandPackage.length());
        return !remainder.isEmpty() && !remainder.contains("/");
    }

    private CommandMetadata readCommandMetadata(Class<?> commandClass) {
        String description = "";
        String arguments = "";
        List<String> aliases = new ArrayList<>();

        for (Method method : commandClass.getDeclaredMethods()) {
            for (Annotation annotation : method.getDeclaredAnnotations()) {
                String annotationName = annotation.annotationType().getSimpleName().toLowerCase(Locale.ROOT);
                if (!annotationName.contains("annotation")) {
                    continue;
                }
                description = firstNonBlank(description, invokeAnnotationString(annotation, "info"));
                arguments = firstNonBlank(arguments, invokeAnnotationString(annotation, "args"));
                aliases.addAll(invokeAnnotationStrings(annotation, "customAlias"));
                aliases.addAll(invokeAnnotationStrings(annotation, "alias"));
            }
        }

        return new CommandMetadata(description, arguments, aliases.stream().distinct().toList());
    }

    private void inspectEnum(
        Plugin plugin,
        Adapter adapter,
        String kind,
        String className,
        List<Row> rows,
        List<String> warnings
    ) {
        if (className == null) {
            return;
        }

        try {
            Class<?> enumClass = Class.forName(className, true, plugin.getClass().getClassLoader());
            Object[] constants = enumClass.getEnumConstants();
            if (constants == null) {
                warnings.add(adapter.id() + ": " + className + " is not an enum");
                return;
            }

            for (Object constant : constants) {
                if ("placeholder".equals(kind) && Boolean.TRUE.equals(invokeBoolean(constant, "isHidden"))) {
                    continue;
                }

                String fallback = constant instanceof Enum<?> value ? value.name() : constant.toString();
                String description = firstNonBlank(
                    invokeString(constant, "getDescription"),
                    invokeString(constant, "getDesc")
                );

                List<String> keys;
                if ("placeholder".equals(kind)) {
                    keys = List.of(firstNonBlank(
                        invokeString(constant, "getFull"),
                        invokeString(constant, "getMVdW"),
                        invokeString(constant, "getName"),
                        fallback
                    ));
                } else {
                    keys = invokeStrings(constant, "getPerms");
                    if (keys.isEmpty()) {
                        int parameterCount = permissionParameterCount(fallback);
                        String key = parameterCount == 0
                            ? invokeString(constant, "getPermission")
                            : invokeStringArguments(constant, "getPermission", permissionArguments(parameterCount));
                        keys = List.of(firstNonBlank(key, fallback));
                    }
                }

                for (String rawKey : keys) {
                    String key = "placeholder".equals(kind)
                        ? normalizePlaceholder(rawKey)
                        : normalizePermission(rawKey, fallback);
                    if (!key.isBlank()) {
                        rows.add(new Row(kind, adapter.id(), key, cleanText(description), "", "", "runtime-enum"));
                    }
                }
            }
        } catch (ExceptionInInitializerError error) {
            warnings.add(adapter.id() + ": " + kind + " initialization failed: " + summarize(error));
        } catch (Exception error) {
            warnings.add(adapter.id() + ": " + kind + " extraction failed: " + summarize(error));
        }
    }

    private String normalizePlaceholder(String value) {
        String trimmed = value.trim();
        if ((trimmed.startsWith("%") && trimmed.endsWith("%")) || trimmed.isEmpty()) {
            return trimmed;
        }
        return "%" + trimmed + "%";
    }

    private String normalizePermission(String value, String enumName) {
        String trimmed = value.trim();
        if (!trimmed.endsWith(".")) {
            return trimmed;
        }

        String variable = "value";
        if (enumName.endsWith("_AMOUNT")) {
            variable = "amount";
        } else if (enumName.endsWith("_WORLDNAME")) {
            variable = "worldName";
        } else if (enumName.endsWith("_JOBNAME")) {
            variable = "jobName";
        }
        return trimmed + "[" + variable + "]";
    }

    private String invokeAnnotationString(Annotation annotation, String methodName) {
        try {
            Method method = annotation.annotationType().getMethod(methodName);
            method.setAccessible(true);
            Object value = method.invoke(annotation);
            return value instanceof String text ? text : "";
        } catch (ReflectiveOperationException ignored) {
            return "";
        }
    }

    private List<String> invokeAnnotationStrings(Annotation annotation, String methodName) {
        try {
            Method method = annotation.annotationType().getMethod(methodName);
            method.setAccessible(true);
            Object value = method.invoke(annotation);
            if (value instanceof String[] values) {
                return Arrays.stream(values).filter(item -> !item.isBlank()).toList();
            }
            if (value != null && value.getClass().isArray()) {
                List<String> values = new ArrayList<>();
                for (int index = 0; index < Array.getLength(value); index++) {
                    Object item = Array.get(value, index);
                    if (item != null && !item.toString().isBlank()) {
                        values.add(item.toString());
                    }
                }
                return values;
            }
        } catch (ReflectiveOperationException ignored) {
            // This annotation does not expose the optional field.
        }
        return List.of();
    }

    private String invokeString(Object target, String methodName) {
        try {
            Method method = target.getClass().getMethod(methodName);
            if (method.getParameterCount() != 0 || method.getReturnType() != String.class) {
                return "";
            }
            method.setAccessible(true);
            Object value = method.invoke(target);
            return value instanceof String text ? text : "";
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            return "";
        }
    }

    private String invokeStringArguments(Object target, String methodName, String[] arguments) {
        try {
            Method method = target.getClass().getMethod(methodName, String[].class);
            method.setAccessible(true);
            Object value = method.invoke(target, (Object) arguments);
            return value instanceof String text ? text : "";
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            return "";
        }
    }

    private List<String> invokeStrings(Object target, String methodName) {
        try {
            Method method = target.getClass().getMethod(methodName);
            method.setAccessible(true);
            Object value = method.invoke(target);
            if (value instanceof Collection<?> values) {
                return values.stream()
                    .filter(item -> item != null && !item.toString().isBlank())
                    .map(Object::toString)
                    .toList();
            }
            if (value != null && value.getClass().isArray()) {
                List<String> values = new ArrayList<>();
                for (int index = 0; index < Array.getLength(value); index++) {
                    Object item = Array.get(value, index);
                    if (item != null && !item.toString().isBlank()) {
                        values.add(item.toString());
                    }
                }
                return values;
            }
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            // This enum does not expose a list-valued metadata method.
        }
        return List.of();
    }

    private int permissionParameterCount(String enumName) {
        int count = 0;
        for (int index = 1; index <= 9; index++) {
            if (enumName.contains("$" + index)) {
                count = index;
            }
        }
        return count;
    }

    private String[] permissionArguments(int count) {
        String[] arguments = new String[count];
        for (int index = 0; index < count; index++) {
            arguments[index] = "$" + (index + 1);
        }
        return arguments;
    }

    private Boolean invokeBoolean(Object target, String methodName) {
        try {
            Method method = target.getClass().getMethod(methodName);
            if (method.getParameterCount() != 0) {
                return null;
            }
            method.setAccessible(true);
            Object value = method.invoke(target);
            return value instanceof Boolean result ? result : null;
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            return null;
        }
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return "";
    }

    private String cleanText(String value) {
        return value
            .replaceAll("(?i)[&§][0-9A-FK-ORX]", "")
            .replace('\t', ' ')
            .replace('\r', ' ')
            .replace('\n', ' ')
            .replaceAll("\\s+", " ")
            .trim();
    }

    private String summarize(Throwable error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();
        String message = cause.getMessage();
        return cause.getClass().getSimpleName() + (message == null ? "" : ": " + cleanText(message));
    }

    private void writeRows(List<Row> rows, List<String> warnings) {
        Path output = getDataFolder().toPath().resolve("generated-indexes.tsv");
        List<String> lines = new ArrayList<>();
        lines.add("kind\tplugin\tkey\tdescription\targuments\taliases\tsource");
        for (Row row : rows) {
            lines.add(String.join(
                "\t",
                escape(row.kind()),
                escape(row.pluginId()),
                escape(row.key()),
                escape(row.description()),
                escape(row.arguments()),
                escape(row.aliases()),
                escape(row.source())
            ));
        }
        for (String warning : warnings) {
            lines.add("warning\tinternal\t" + escape(warning) + "\t\t\t\truntime-exporter");
        }

        try {
            Files.createDirectories(output.getParent());
            Files.write(output, lines, StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new IllegalStateException("Could not write " + output, error);
        }
    }

    private String escape(String value) {
        return value.replace("\\", "\\\\").replace("\t", "\\t").replace("\r", "\\r").replace("\n", "\\n");
    }

    private record Adapter(
        String id,
        String pluginName,
        String commandRoot,
        String commandPackage,
        String placeholderClass,
        String permissionClass
    ) {}

    private record CommandMetadata(String description, String arguments, List<String> aliases) {}

    private record Row(
        String kind,
        String pluginId,
        String key,
        String description,
        String arguments,
        String aliases,
        String source
    ) {}
}
