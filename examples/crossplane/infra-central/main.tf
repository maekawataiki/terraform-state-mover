resource "aws_iam_role" "crossplane_db_role" {
  name               = "crossplane-db-access"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "crossplane_storage_role" {
  name               = "crossplane-storage-access"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_s3_bucket" "data_lake" {
  bucket = "acme-data-lake-prod"
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "acme-artifacts-prod"
}
