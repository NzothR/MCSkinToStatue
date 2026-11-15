package local.skinstatue.index;

import java.io.File;
import java.io.IOException;

import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.IReloadableResourceManager;
import net.minecraft.command.CommandBase;
import net.minecraft.command.ICommandSender;
import net.minecraft.util.ChatComponentText;
import net.minecraftforge.client.ClientCommandHandler;
import net.minecraftforge.common.config.Configuration;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.Mod;
import cpw.mods.fml.common.event.FMLInitializationEvent;
import cpw.mods.fml.common.event.FMLPreInitializationEvent;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;

/** Client-only registry exporter. Never places blocks or changes world data. */
@Mod(
    modid = "skinstatueindex",
    name = "Skin Statue Index",
    version = "0.1.0",
    acceptedMinecraftVersions = "[1.7.10]",
    acceptableRemoteVersions = "*")
public final class SkinStatueIndex {

    private boolean automatic;
    private boolean debug;
    private boolean exported;
    private int waitTicks;
    private ExportJob job;

    /** Read the client configuration. The debug log is opt-in. */
    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        Configuration config = new Configuration(event.getSuggestedConfigurationFile());
        automatic = config.getBoolean(
            "exportOnFirstWorld",
            "general",
            true,
            "Export once per client session, 60 ticks after entering a world.");
        debug = config.getBoolean("debugLogging", "general", false, "Enable per-state diagnostic logging.");
        if (config.hasChanged()) config.save();
    }

    /** Register the client command and incremental export tick handler. */
    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        FMLCommonHandler.instance()
            .bus()
            .register(this);
        ((IReloadableResourceManager) Minecraft.getMinecraft()
            .getResourceManager()).registerReloadListener(manager -> {
                if (job != null) {
                    job.cancel();
                    job = null;
                    reportResourceReload();
                }
            });
        ClientCommandHandler.instance.registerCommand(new CommandBase() {

            @Override
            public String getCommandName() {
                return "skinindex";
            }

            @Override
            public String getCommandUsage(ICommandSender sender) {
                return "/skinindex export|status|cancel";
            }

            @Override
            public int getRequiredPermissionLevel() {
                return 0;
            }

            @Override
            public void processCommand(ICommandSender sender, String[] args) {
                String action = args.length == 0 ? "export" : args[0];
                if ("export".equals(action)) {
                    start();
                } else if ("status".equals(action)) {
                    message(job == null ? "No export running." : job.progress());
                } else if ("cancel".equals(action)) {
                    if (job != null) {
                        job.cancel();
                        job = null;
                        message("Export cancelled. Partial output removed.");
                    }
                } else {
                    message(getCommandUsage(sender));
                }
            }
        });
    }

    /** Explain why a resource reload invalidated an in-progress snapshot. */
    private static void reportResourceReload() {
        ExportJob.LOG.info("Resource reload cancelled the running export; rerun /skinindex export.");
        if (Minecraft.getMinecraft().thePlayer != null) message("Resources reloaded. Run /skinindex export again.");
    }

    /** Start after world registry remapping, on the client render thread. */
    private void start() {
        Minecraft mc = Minecraft.getMinecraft();
        if (job != null) {
            message(job.progress());
            return;
        }
        if (mc.theWorld == null || mc.thePlayer == null) {
            message("Enter a world first.");
            return;
        }
        try {
            job = new ExportJob(new File(mc.mcDataDir, "skin-statue-index"), debug);
            exported = true;
            message("Export started. Active resource-pack textures are included. /skinindex status");
        } catch (IOException exception) {
            ExportJob.LOG.error("Cannot start block index export", exception);
            message("Cannot create export: " + exception.getMessage());
        }
    }

    /** Limit work per frame and cancel when leaving the world. */
    @SubscribeEvent
    public void onTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) return;
        Minecraft mc = Minecraft.getMinecraft();
        if (mc.theWorld == null || mc.thePlayer == null) {
            waitTicks = 0;
            if (job != null) {
                job.cancel();
                job = null;
            }
            return;
        }
        if (automatic && !exported && ++waitTicks == 60) start();
        if (job == null) return;
        try {
            if (job.tick()) {
                message(
                    "Export complete: " + job.getOutput()
                        .getAbsolutePath());
                job = null;
            }
        } catch (IOException | RuntimeException exception) {
            ExportJob.LOG.error("Block index export failed", exception);
            message("Export failed: " + exception.getMessage() + ". See logs/latest.log.");
            job.cancel();
            job = null;
        }
    }

    /** Report lifecycle and progress without per-frame chat spam. */
    private static void message(String text) {
        Minecraft.getMinecraft().thePlayer.addChatMessage(new ChatComponentText("[Skin Statue] " + text));
    }
}
