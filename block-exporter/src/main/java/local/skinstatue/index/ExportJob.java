package local.skinstatue.index;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.nio.IntBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

import javax.imageio.ImageIO;

import net.minecraft.block.Block;
import net.minecraft.block.BlockDragonEgg;
import net.minecraft.block.BlockFalling;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.creativetab.CreativeTabs;
import net.minecraft.item.Item;
import net.minecraft.item.ItemBlock;
import net.minecraft.item.ItemBow;
import net.minecraft.item.ItemStack;
import net.minecraft.util.IIcon;
import net.minecraft.util.ResourceLocation;
import net.minecraft.world.IBlockAccess;
import net.minecraft.world.World;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL12;
import org.lwjgl.opengl.GL15;
import org.lwjgl.opengl.GL21;
import org.lwjgl.opengl.GL30;
import org.lwjgl.opengl.GLContext;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

/** Versioned ZIP containing the live registry and decoded, resource-pack-resolved atlas pixels. */
final class ExportJob {

    static final Logger LOG = LogManager.getLogger("SkinStatueIndex");
    private static final String[] FACES = { "down", "up", "north", "south", "west", "east" };
    private final List<String> names = new ArrayList<>();
    private final JsonArray blocks = new JsonArray();
    private final JsonArray items = new JsonArray();
    private final List<String> itemNames = new ArrayList<>();
    private int itemCursor;
    private int variantCursor;
    private List<ItemStack> itemVariants;
    private boolean itemCreative;
    private final JsonArray errors = new JsonArray();
    private final Map<String, JsonObject> textureCache = new HashMap<>();
    private final ZipOutputStream zip;
    private final File partial;
    private final File output;
    private final boolean debug;
    private final String packs;
    private final JsonArray contextualRules = new JsonArray();
    private int blockCursor;
    private int metadata;
    private Block block;
    private JsonObject blockJson;
    private JsonArray states;
    private Set<Integer> creativeMetadata;
    private Map<Integer, String> creativeNames;
    private int readFramebuffer = -1;
    private final World capturedWorld;

    /** Snapshot the active names after the client has entered a world. */
    ExportJob(File directory, boolean debug) throws IOException {
        Files.createDirectories(directory.toPath());
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss-SSS").format(new Date());
        output = new File(directory, "block-index-" + stamp + ".zip");
        partial = new File(directory, "block-index-" + stamp + ".zip.part");
        this.debug = debug;
        capturedWorld = Minecraft.getMinecraft().theWorld;
        for (Object key : Block.blockRegistry.getKeys()) names.add(key.toString());
        Collections.sort(names);
        for (Object key : Item.itemRegistry.getKeys()) itemNames.add(key.toString());
        Collections.sort(itemNames);
        packs = Minecraft.getMinecraft().gameSettings.resourcePacks.toString();
        capturePackRules();
        zip = new ZipOutputStream(new FileOutputStream(partial));
    }

    /** Process states for at most approximately 6 ms per tick; one state is indivisible. */
    boolean tick() throws IOException {
        if (Minecraft.getMinecraft().theWorld != capturedWorld) throw new IOException("World changed during export.");
        if (!packs.equals(Minecraft.getMinecraft().gameSettings.resourcePacks.toString())) {
            throw new IOException("Resource packs changed during export. Run /skinindex export again.");
        }
        long deadline = System.nanoTime() + 6_000_000L;
        do {
            if (blockCursor == names.size()) {
                if (itemCursor == itemNames.size()) {
                    finish();
                    return true;
                }
                captureNextItem();
                continue;
            }
            if (block == null) beginBlock();
            captureState();
            if (++metadata == 16) {
                blocks.add(blockJson);
                blockCursor++;
                block = null;
            }
        } while (System.nanoTime() < deadline);
        return false;
    }

    /** Enumerate real creative variants and capture one stack per tick budget, including NBT names. */
    private void captureNextItem() throws IOException {
        String name = itemNames.get(itemCursor);
        Item item = (Item) Item.itemRegistry.getObject(name);
        if (itemVariants == null) {
            List<ItemStack> discovered = new ArrayList<>();
            try {
                for (CreativeTabs tab : item.getCreativeTabs()) item.getSubItems(item, tab, discovered);
            } catch (RuntimeException | LinkageError exception) {
                recordError(name, -1, "item_variants", exception);
            }
            itemVariants = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            for (ItemStack stack : discovered) {
                if (stack == null || stack.getItem() != item) continue;
                String key = stack.getItemDamage() + ":" + stack.getTagCompound();
                if (seen.add(key)) itemVariants.add(stack);
            }
            itemCreative = !itemVariants.isEmpty();
            if (itemVariants.isEmpty()) itemVariants.add(new ItemStack(item, 1, 0));
            variantCursor = 0;
        }
        ItemStack stack = itemVariants.get(variantCursor);
        JsonObject entry = new JsonObject();
        entry.addProperty("registry_name", name);
        entry.addProperty("numeric_id", Item.getIdFromItem(item));
        entry.addProperty("damage", stack.getItemDamage());
        entry.addProperty("creative_confirmed", itemCreative);
        if (stack.hasTagCompound()) entry.addProperty(
            "nbt",
            stack.getTagCompound()
                .toString());
        JsonArray layers = new JsonArray();
        entry.add("layers", layers);
        try {
            entry.addProperty("display_name", stack.getDisplayName());
            entry.addProperty("unlocalized_name", stack.getUnlocalizedName());
            entry.addProperty("render_kind", item instanceof ItemBow ? "bow" : item.isFull3D() ? "tool" : "flat");
            entry.addProperty("rotate_around", item.shouldRotateAroundWhenRendering());
            entry
                .addProperty(
                    "custom_equipped_renderer",
                    net.minecraftforge.client.MinecraftForgeClient
                        .getItemRenderer(stack, net.minecraftforge.client.IItemRenderer.ItemRenderType.EQUIPPED)
                        != null);
            if (item instanceof ItemBlock) {
                Block itemBlock = Block.getBlockFromItem(item);
                entry.addProperty("block_registry_name", Block.blockRegistry.getNameForObject(itemBlock));
                entry.addProperty("block_metadata", item.getMetadata(stack.getItemDamage()));
            }
            int passes = item.requiresMultipleRenderPasses() ? item.getRenderPasses(stack.getItemDamage()) : 1;
            for (int pass = 0; pass < passes; pass++) {
                IIcon icon = item.getIcon(stack, pass);
                if (icon == null) throw new IllegalStateException("Missing item icon pass " + pass);
                JsonObject layer = new JsonObject();
                layer.add("texture", captureTexture(icon, stack.getItemSpriteNumber()));
                layer.addProperty("tint", item.getColorFromItemStack(stack, pass) & 0xffffff);
                layers.add(layer);
            }
            entry.addProperty("status", "captured");
        } catch (RuntimeException | LinkageError exception) {
            entry.addProperty("status", "unresolved");
            entry.addProperty("error", exception.toString());
            recordError(name, stack.getItemDamage(), "item_icon", exception);
        }
        items.add(entry);
        if (++variantCursor == itemVariants.size()) {
            itemCursor++;
            itemVariants = null;
        }
    }

    /** Record every registry entry, with creative-list metadata distinguished from probed states. */
    @SuppressWarnings({ "rawtypes", "unchecked" })
    private void beginBlock() {
        String name = names.get(blockCursor);
        block = (Block) Block.blockRegistry.getObject(name);
        metadata = 0;
        blockJson = new JsonObject();
        blockJson.addProperty("registry_name", name);
        blockJson.addProperty("numeric_id", Block.getIdFromBlock(block));
        blockJson.addProperty(
            "class_name",
            block.getClass()
                .getName());
        JsonArray hierarchy = new JsonArray();
        boolean gravity = block instanceof BlockFalling || block instanceof BlockDragonEgg;
        for (Class<?> type = block.getClass(); type != null; type = type.getSuperclass()) {
            hierarchy.add(new JsonPrimitive(type.getName()));
            gravity |= "de.katzenpapst.amunra.block.BlockFallingMeta".equals(type.getName());
        }
        blockJson.add("class_hierarchy", hierarchy);
        blockJson.addProperty("gravity_affected", gravity);
        blockJson.addProperty("metadata_source", "probe_0_15_with_creative_confirmation");
        try {
            blockJson.addProperty("world_dependent_icon", overridesWorldMethod(block.getClass(), IIcon.class, 5));
            blockJson.addProperty("world_dependent_color", overridesWorldMethod(block.getClass(), int.class, 4));
        } catch (RuntimeException | LinkageError exception) {
            blockJson.addProperty("world_dependent_icon", true);
            blockJson.addProperty("world_dependent_color", true);
            recordError(name, -1, "class_inspection", exception);
        }
        states = new JsonArray();
        blockJson.add("states", states);
        creativeMetadata = new HashSet<>();
        creativeNames = new HashMap<>();
        Item item = Item.getItemFromBlock(block);
        if (item != null) {
            List items = new ArrayList();
            try {
                // Keep the stable vanilla/custom tab label, independent of the selected language.
                CreativeTabs tab = block.getCreativeTabToDisplayOn();
                if (tab != null) blockJson.addProperty("creative_tab", tab.getTabLabel());
                block.getSubBlocks(item, block.getCreativeTabToDisplayOn(), items);
                for (Object value : items) {
                    if (value instanceof ItemStack) {
                        ItemStack stack = (ItemStack) value;
                        int meta = stack.getItem()
                            .getMetadata(stack.getItemDamage());
                        if (meta >= 0 && meta < 16) {
                            creativeMetadata.add(meta);
                            // Use the real creative stack, including variant damage and NBT names.
                            creativeNames.putIfAbsent(meta, stack.getDisplayName());
                        }
                    }
                }
            } catch (RuntimeException | LinkageError exception) {
                recordError(name, -1, "creative_metadata", exception);
            }
        }
    }

    /** Capture static six-face icons, render classification and tint without accessing or changing blocks. */
    private void captureState() throws IOException {
        JsonObject state = new JsonObject();
        state.addProperty("metadata", metadata);
        state.addProperty("creative_confirmed", creativeMetadata.contains(metadata));
        if (creativeNames.containsKey(metadata)) state.addProperty("display_name", creativeNames.get(metadata));
        JsonObject faces = new JsonObject();
        state.add("faces", faces);
        try {
            state.addProperty("normal_cube", block.renderAsNormalBlock());
            state.addProperty("opaque", block.isOpaqueCube());
            state.addProperty("render_type", block.getRenderType());
            state.addProperty("has_tile_entity", block.hasTileEntity(metadata));
            state.addProperty("render_color", block.getRenderColor(metadata) & 0xffffff);
            state.addProperty("light_value", block.getLightValue());
            for (int side = 0; side < 6; side++) {
                IIcon icon = block.getIcon(side, metadata);
                if (icon == null) throw new IllegalStateException("No icon for side " + side);
                faces.add(FACES[side], captureTexture(icon));
            }
            state.addProperty("status", "captured");
        } catch (RuntimeException | LinkageError exception) {
            state.addProperty("status", "unresolved");
            state.addProperty(
                "error",
                exception.getClass()
                    .getName() + ": "
                    + exception.getMessage());
            recordError(names.get(blockCursor), metadata, "state", exception);
        }
        states.add(state);
    }

    /** Decode the loaded atlas sprite, which already includes active pack priority and generated textures. */
    private JsonObject captureTexture(IIcon icon) throws IOException {
        return captureTexture(icon, 0);
    }

    /** Keep block/item atlas namespaces separate even when icon names coincide. */
    private JsonObject captureTexture(IIcon icon, int atlasType) throws IOException {
        String name = icon.getIconName();
        String cacheKey = atlasType + ":" + name;
        JsonObject cached = textureCache.get(cacheKey);
        if (cached != null) return cached;
        if (!(icon instanceof TextureAtlasSprite)) {
            throw new IllegalStateException(
                "Custom IIcon needs renderer-specific support: " + icon.getClass()
                    .getName());
        }
        TextureAtlasSprite sprite = (TextureAtlasSprite) icon;
        TextureMap atlas = atlasType == 0 ? Minecraft.getMinecraft()
            .getTextureMapBlocks()
            : (TextureMap) Minecraft.getMinecraft()
                .getTextureManager()
                .getTexture(TextureMap.locationItemsTexture);
        if ("missingno".equals(
            atlas.getAtlasSprite(name)
                .getIconName())) {
            throw new IllegalStateException("Icon is not present in the loaded block atlas: " + name);
        }
        if ("missingno".equals(name) || name.endsWith(":missingno")) {
            throw new IllegalStateException("Missing texture: " + name);
        }
        int width = sprite.getIconWidth();
        int height = sprite.getIconHeight();
        BufferedImage image;
        String pixelSource;
        if (sprite.getFrameCount() > 0) {
            int[][] frame = sprite.getFrameTextureData(0);
            if (frame == null || frame.length == 0 || frame[0] == null || frame[0].length != width * height) {
                throw new IllegalStateException("Invalid atlas pixel data: " + name);
            }
            image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
            image.setRGB(0, 0, width, height, frame[0], 0, width);
            pixelSource = "loaded_atlas_frame_0";
        } else if (GLContext.getCapabilities().OpenGL30) {
            image = readAtlas(sprite, atlas);
            pixelSource = "loaded_gpu_atlas";
        } else {
            // Minecraft may discard static sprite CPU pixels after uploading the atlas.
            // Only standard sprites can then be recovered through TextureMap's standard resource path.
            if (sprite.getClass() != TextureAtlasSprite.class) {
                throw new IllegalStateException("Generated sprite CPU pixels unavailable: " + name);
            }
            ResourceLocation location = new ResourceLocation(name);
            ResourceLocation pngLocation = new ResourceLocation(
                location.getResourceDomain(),
                (atlasType == 0 ? "textures/blocks/" : "textures/items/") + location.getResourcePath() + ".png");
            try (InputStream stream = Minecraft.getMinecraft()
                .getResourceManager()
                .getResource(pngLocation)
                .getInputStream()) {
                image = ImageIO.read(stream);
            } catch (IOException exception) {
                throw new IllegalStateException("Cannot resolve active texture " + pngLocation, exception);
            }
            if (image == null || image.getWidth() != width || image.getHeight() != height) {
                throw new IllegalStateException("Resource dimensions differ from loaded sprite: " + name);
            }
            pixelSource = "active_resource_manager";
        }
        // Recover atlas dimensions from the symmetric UV bounds. This also removes the
        // 8-pixel border Minecraft may add for anisotropic filtering.
        double atlasWidth = (2.0 * sprite.getOriginX() + width) / (sprite.getMinU() + sprite.getMaxU());
        double atlasHeight = (2.0 * sprite.getOriginY() + height) / (sprite.getMinV() + sprite.getMaxV());
        int left = (int) Math.round(sprite.getMinU() * atlasWidth) - sprite.getOriginX();
        int top = (int) Math.round(sprite.getMinV() * atlasHeight) - sprite.getOriginY();
        int right = (int) Math.round(sprite.getMaxU() * atlasWidth) - sprite.getOriginX();
        int bottom = (int) Math.round(sprite.getMaxV() * atlasHeight) - sprite.getOriginY();
        image = image.getSubimage(left, top, right - left, bottom - top);
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        ImageIO.write(image, "PNG", png);
        String path = "textures/" + textureCache.size() + ".png";
        writeEntry(path, png.toByteArray());
        JsonObject result = new JsonObject();
        result.addProperty("icon_name", name);
        result.addProperty("path", path);
        result.addProperty("width", image.getWidth());
        result.addProperty("height", image.getHeight());
        result.addProperty("animated", sprite.hasAnimationMetadata() || sprite.getFrameCount() > 1);
        result.addProperty(
            "sprite_class",
            sprite.getClass()
                .getName());
        result.addProperty("pixel_source", pixelSource);
        ResourceLocation iconLocation = new ResourceLocation(name);
        ResourceLocation metadataLocation = new ResourceLocation(
            iconLocation.getResourceDomain(),
            (atlasType == 0 ? "textures/blocks/" : "textures/items/") + iconLocation.getResourcePath() + ".png.mcmeta");
        boolean connected = false;
        try (InputStreamReader reader = new InputStreamReader(
            Minecraft.getMinecraft()
                .getResourceManager()
                .getResource(metadataLocation)
                .getInputStream(),
            StandardCharsets.UTF_8)) {
            JsonObject metadata = new JsonParser().parse(reader)
                .getAsJsonObject();
            connected = metadata.has("myctmlib") && metadata.getAsJsonObject("myctmlib")
                .has("connection");
        } catch (FileNotFoundException absentMetadata) {
            // PNG sidecar metadata is optional; absence is an ordinary non-connected texture.
        }
        result.addProperty("connected_texture", connected);
        textureCache.put(cacheKey, result);
        return result;
    }

    /** Preserve CTM selectors so the palette can exclude context-sensitive replacements. */
    private void capturePackRules() throws IOException {
        for (Object selected : Minecraft.getMinecraft().gameSettings.resourcePacks) {
            File pack = new File(new File(Minecraft.getMinecraft().mcDataDir, "resourcepacks"), selected.toString());
            if (pack.isDirectory()) {
                try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(pack.toPath())) {
                    java.util.Iterator<java.nio.file.Path> iterator = paths.iterator();
                    while (iterator.hasNext()) {
                        java.nio.file.Path path = iterator.next();
                        String name = pack.toPath()
                            .relativize(path)
                            .toString()
                            .replace('\\', '/');
                        if (name.contains("/ctm/") && name.endsWith(".properties")) {
                            try (InputStream stream = Files.newInputStream(path)) {
                                addPackRule(pack.getName(), name, stream);
                            }
                        }
                    }
                }
            } else {
                try (ZipFile source = new ZipFile(pack)) {
                    Enumeration<? extends ZipEntry> entries = source.entries();
                    while (entries.hasMoreElements()) {
                        ZipEntry entry = entries.nextElement();
                        if (entry.getName()
                            .contains("/ctm/")
                            && entry.getName()
                                .endsWith(".properties")) {
                            try (InputStream stream = source.getInputStream(entry)) {
                                addPackRule(pack.getName(), entry.getName(), stream);
                            }
                        }
                    }
                }
            }
        }
    }

    /** Store selector properties without attempting to reproduce a connected-texture renderer. */
    private void addPackRule(String pack, String path, InputStream stream) throws IOException {
        Properties properties = new Properties();
        properties.load(stream);
        JsonObject rule = new JsonObject();
        rule.addProperty("pack", pack);
        rule.addProperty("path", path);
        for (String key : properties.stringPropertyNames()) rule.addProperty(key, properties.getProperty(key));
        contextualRules.add(rule);
    }

    /** Read only a sprite rectangle from the live atlas; restore read-FBO and pixel-pack state. */
    private BufferedImage readAtlas(TextureAtlasSprite sprite, TextureMap atlas) {
        int previous = GL11.glGetInteger(GL30.GL_READ_FRAMEBUFFER_BINDING);
        int buffer = GL11.glGetInteger(GL21.GL_PIXEL_PACK_BUFFER_BINDING);
        int alignment = GL11.glGetInteger(GL11.GL_PACK_ALIGNMENT);
        int rowLength = GL11.glGetInteger(GL11.GL_PACK_ROW_LENGTH);
        int skipRows = GL11.glGetInteger(GL11.GL_PACK_SKIP_ROWS);
        int skipPixels = GL11.glGetInteger(GL11.GL_PACK_SKIP_PIXELS);
        int swapBytes = GL11.glGetInteger(GL11.GL_PACK_SWAP_BYTES);
        if (readFramebuffer < 0) readFramebuffer = GL30.glGenFramebuffers();
        int w = sprite.getIconWidth();
        int h = sprite.getIconHeight();
        IntBuffer pixels = BufferUtils.createIntBuffer(w * h);
        try {
            GL30.glBindFramebuffer(GL30.GL_READ_FRAMEBUFFER, readFramebuffer);
            GL30.glFramebufferTexture2D(
                GL30.GL_READ_FRAMEBUFFER,
                GL30.GL_COLOR_ATTACHMENT0,
                GL11.GL_TEXTURE_2D,
                atlas.getGlTextureId(),
                0);
            if (GL30.glCheckFramebufferStatus(GL30.GL_READ_FRAMEBUFFER) != GL30.GL_FRAMEBUFFER_COMPLETE) {
                throw new IllegalStateException("Cannot read the loaded block texture atlas framebuffer");
            }
            GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, 0);
            GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, 4);
            GL11.glPixelStorei(GL11.GL_PACK_ROW_LENGTH, 0);
            GL11.glPixelStorei(GL11.GL_PACK_SKIP_ROWS, 0);
            GL11.glPixelStorei(GL11.GL_PACK_SKIP_PIXELS, 0);
            GL11.glPixelStorei(GL11.GL_PACK_SWAP_BYTES, 0);
            GL11.glReadPixels(
                sprite.getOriginX(),
                sprite.getOriginY(),
                w,
                h,
                GL12.GL_BGRA,
                GL12.GL_UNSIGNED_INT_8_8_8_8_REV,
                pixels);
            int[] argb = new int[w * h];
            pixels.get(argb);
            BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
            // Atlas upload puts PNG row zero at texture y=0, so no framebuffer screenshot flip is needed.
            image.setRGB(0, 0, w, h, argb, 0, w);
            return image;
        } finally {
            GL30.glBindFramebuffer(GL30.GL_READ_FRAMEBUFFER, previous);
            GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, buffer);
            GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, alignment);
            GL11.glPixelStorei(GL11.GL_PACK_ROW_LENGTH, rowLength);
            GL11.glPixelStorei(GL11.GL_PACK_SKIP_ROWS, skipRows);
            GL11.glPixelStorei(GL11.GL_PACK_SKIP_PIXELS, skipPixels);
            GL11.glPixelStorei(GL11.GL_PACK_SWAP_BYTES, swapBytes);
        }
    }

    /** Detect the exact world icon/color overrides under MCP or Forge runtime SRG names. */
    private static boolean overridesWorldMethod(Class<?> type, Class<?> result, int count) {
        String mcp = result == IIcon.class ? "getIcon" : "colorMultiplier";
        String srg = result == IIcon.class ? "func_149673_e" : "func_149720_d";
        for (Class<?> current = type; current != Block.class && current != null; current = current.getSuperclass()) {
            for (Method method : current.getDeclaredMethods()) {
                if (!method.getName()
                    .equals(mcp)
                    && !method.getName()
                        .equals(srg))
                    continue;
                Class<?>[] args = method.getParameterTypes();
                if (method.getReturnType() == result && args.length == count && args[0] == IBlockAccess.class) {
                    boolean integers = true;
                    for (int i = 1; i < args.length; i++) integers &= args[i] == int.class;
                    if (integers) return true;
                }
            }
        }
        return false;
    }

    /** Preserve per-block failures in the archive, with detailed logging only when configured. */
    private void recordError(String name, int meta, String stage, Throwable exception) {
        JsonObject error = new JsonObject();
        error.addProperty("registry_name", name);
        error.addProperty("metadata", meta);
        error.addProperty("stage", stage);
        error.addProperty(
            "error",
            exception.getClass()
                .getName() + ": "
                + exception.getMessage());
        errors.add(error);
        if (debug) LOG.warn("Cannot capture {}:{} at {}", name, meta, stage, exception);
    }

    /** Close a complete versioned manifest before renaming the partial archive into place. */
    private void finish() throws IOException {
        JsonObject root = new JsonObject();
        root.addProperty("format", "skin-statue-block-index");
        root.addProperty("schema_version", 1);
        root.addProperty("exporter_version", "0.1.4");
        root.addProperty("minecraft_version", "1.7.10");
        root.addProperty("language", Minecraft.getMinecraft().gameSettings.language);
        root.addProperty("capture_scope", "static_getIcon_resolved_atlas");
        root.addProperty("created_at", new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX").format(new Date()));
        JsonArray packsJson = new JsonArray();
        for (Object pack : Minecraft.getMinecraft().gameSettings.resourcePacks)
            packsJson.add(new JsonPrimitive(pack.toString()));
        root.add("resource_packs", packsJson);
        root.add("contextual_rules", contextualRules);
        root.addProperty(
            "server_resource_pack",
            Minecraft.getMinecraft()
                .getResourcePackRepository()
                .func_148530_e() != null);
        root.add("blocks", blocks);
        root.add("items", items);
        root.addProperty("item_registry_count", itemNames.size());
        root.add("errors", errors);
        writeEntry(
            "registry.json",
            new GsonBuilder().setPrettyPrinting()
                .create()
                .toJson(root)
                .getBytes(StandardCharsets.UTF_8));
        zip.close();
        closeFramebuffer();
        Files.move(partial.toPath(), output.toPath(), StandardCopyOption.ATOMIC_MOVE);
        LOG.info(
            "Exported {} blocks and {} textures to {}; {} issues",
            names.size(),
            textureCache.size(),
            output,
            errors.size());
    }

    /** Add one named payload to the index archive. */
    private void writeEntry(String name, byte[] bytes) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(bytes);
        zip.closeEntry();
    }

    /** Remove only this job's incomplete archive. */
    void cancel() {
        closeFramebuffer();
        try {
            zip.close();
            Files.deleteIfExists(partial.toPath());
        } catch (IOException exception) {
            LOG.error("Cannot remove incomplete index {}", partial, exception);
        }
    }

    /** Release only the GL object created by this exporter. */
    private void closeFramebuffer() {
        if (readFramebuffer >= 0) {
            GL30.glDeleteFramebuffers(readFramebuffer);
            readFramebuffer = -1;
        }
    }

    /** Return a compact progress message for the manual status command. */
    String progress() {
        return "Blocks " + blockCursor
            + "/"
            + names.size()
            + "; items "
            + itemCursor
            + "/"
            + itemNames.size()
            + "; textures "
            + textureCache.size();
    }

    /** Return the final archive path. */
    File getOutput() {
        return output;
    }
}
