# Keep kotlinx.serialization generated serializers for the TV API models.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class io.streamlift.tv.data.** {
    *** Companion;
}
-keepclasseswithmembers class io.streamlift.tv.data.** {
    kotlinx.serialization.KSerializer serializer(...);
}
