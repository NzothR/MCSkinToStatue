plugins {
    id("com.gtnewhorizons.gtnhconvention")
}

version = "0.1.4"

extensions.configure<com.gtnewhorizons.retrofuturagradle.MinecraftExtension>("minecraft") {
    jvmLanguageVersion.set(JavaLanguageVersion.of(25))
}

val java25 = javaToolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(25)) }
tasks.withType<com.gtnewhorizons.retrofuturagradle.mcp.DecompileTask>().configureEach {
    java17Launcher.set(java25)
    java8Launcher.set(java25)
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(8)
}
